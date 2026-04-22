// src/enrichment/firecrawl.js
// Enriches leads by scraping their websites using Firecrawl
// Caches results in website_enrichments table — never scrapes the same domain twice
// Falls back to contact page if homepage has no email

import FirecrawlApp from '@mendable/firecrawl-js';
import { createClient } from '@supabase/supabase-js';

const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ENRICHMENT_SCHEMA = {
  type: 'object',
  properties: {
    one_liner: {
      type: 'string',
      description: 'One sentence describing what this business actually does. No marketing fluff.',
    },
    services: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific services offered as listed on the site.',
    },
    specialisms: {
      type: 'array',
      items: { type: 'string' },
      description: 'Niche or specialist areas.',
    },
    team_size_signal: {
      type: 'string',
      enum: ['solo', 'small', 'medium', 'large', 'unknown'],
      description: 'solo=1, small=2-10, medium=11-50, large=50+',
    },
    decision_maker: {
      type: 'object',
      properties: {
        name: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low', 'unverified'],
        },
      },
    },
    recent_projects: {
      type: 'array',
      items: { type: 'string' },
      description: 'Recent project or case study titles.',
    },
    notable_clients: {
      type: 'array',
      items: { type: 'string' },
    },
    awards_certifications: {
      type: 'array',
      items: { type: 'string' },
    },
    years_in_business: { type: ['integer', 'null'] },
    geographic_coverage: {
      type: 'string',
      enum: ['local', 'regional', 'national', 'international', 'unknown'],
    },
    contact: {
      type: 'object',
      properties: {
        email: { type: ['string', 'null'] },
        phone: { type: ['string', 'null'] },
      },
    },
    pain_hooks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Observable signals of problems this business might have.',
    },
    personalization_hooks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          hook: { type: 'string' },
          source_quote: {
            type: 'string',
            description: 'Exact phrase from the website supporting this hook.',
          },
        },
      },
      description: 'Specific verifiable details usable in a cold email opener.',
    },
  },
  required: ['one_liner', 'services', 'team_size_signal', 'personalization_hooks'],
};

// Minimal schema just for extracting contact details from contact pages
const CONTACT_SCHEMA = {
  type: 'object',
  properties: {
    email: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    contact_name: { type: ['string', 'null'] },
  },
};

const EXTRACTION_PROMPT = `
You are enriching a B2B lead profile from a company website.
Extract only information visibly present on the page. Never fabricate.
If a field is not present set it to null or empty array.

Rules:
- one_liner: what they DO not what they claim. Facts over adjectives.
- personalization_hooks: each must include a source_quote — exact phrase from the site. No quote = don't include it.
- Avoid RAMS, ISO certifications, H&S policies — too technical for cold email personalisation.
- decision_maker: only populate if name AND title are clearly associated with leadership. Otherwise leave null.
- contact.email: look carefully in footer, contact links, mailto links, and anywhere on the page.
- contact.phone: look in header, footer, contact sections.
`.trim();

const CONTACT_EXTRACTION_PROMPT = `
Extract contact information from this page.
Look carefully for email addresses in: mailto links, text containing @, footer, contact forms, staff listings.
Look for phone numbers anywhere on the page.
Never fabricate. If not found set to null.
`.trim();

const WRAPPER_TIMEOUT_MS = 45000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

// ============================================
// HELPERS
// ============================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const normaliseUrl = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const extractDomain = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

const isSameDomain = (inputUrl, resultUrl) => {
  try {
    const a = new URL(inputUrl).hostname.replace(/^www\./, '');
    const b = new URL(resultUrl).hostname.replace(/^www\./, '');
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  } catch {
    return false;
  }
};

const isEmptyEnrichment = (data) => {
  if (!data) return true;
  const hasBasics = data.one_liner && data.one_liner.length > 10;
  const hasHooks = Array.isArray(data.personalization_hooks) && data.personalization_hooks.length > 0;
  const hasServices = Array.isArray(data.services) && data.services.length > 0;
  return !hasBasics && !hasHooks && !hasServices;
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} after ${ms}ms`)), ms)
    ),
  ]);

// ============================================
// CACHE
// ============================================

const checkCache = async (domain) => {
  try {
    const { data, error } = await supabase
      .from('website_enrichments')
      .select('*')
      .eq('domain', domain)
      .single();

    if (error || !data) return null;
    console.log(`   💾 Cache hit for ${domain} — skipping scrape`);
    return data;
  } catch {
    return null;
  }
};

const saveToCache = async (domain, url, enrichmentResult) => {
  try {
    await supabase
      .from('website_enrichments')
      .upsert({
        domain,
        url,
        enrichment_data: enrichmentResult.enrichment_data,
        enrichment_status: enrichmentResult.enrichment_status,
        error: enrichmentResult.error,
        scraped_at: new Date().toISOString(),
        credits_used: 5,
      }, { onConflict: 'domain' });
  } catch (err) {
    console.error(`Cache save failed for ${domain}:`, err.message);
  }
};

// ============================================
// SCRAPE
// ============================================

const scrapeUrl = async (url, schema, prompt) => {
  const startedAt = Date.now();

  const result = await withTimeout(
    firecrawl.scrapeUrl(url, {
      formats: ['markdown', 'json'],
      jsonOptions: { prompt, schema },
      onlyMainContent: true,
      waitFor: 2000,
      timeout: DEFAULT_TIMEOUT_MS,
    }),
    WRAPPER_TIMEOUT_MS,
    `scrape:${url}`
  );

  return {
    duration_ms: Date.now() - startedAt,
    data: result?.json ?? null,
    source_url: result?.metadata?.sourceURL ?? result?.metadata?.url ?? url,
  };
};

// Try to find email from contact pages if homepage didn't have one
const tryContactPages = async (baseUrl) => {
  const contactPaths = ['/contact', '/contact-us', '/about', '/about-us', '/get-in-touch'];

  for (const path of contactPaths) {
    try {
      const contactUrl = baseUrl.replace(/\/$/, '') + path;
      const { data } = await scrapeUrl(contactUrl, CONTACT_SCHEMA, CONTACT_EXTRACTION_PROMPT);

      if (data?.email) {
        console.log(`   📧 Found email on ${path}`);
        return { email: data.email, phone: data.phone || null };
      }
    } catch {
      // Page not found or error — try next
    }
    await sleep(500);
  }

  return null;
};

// ============================================
// MAIN EXPORT — enrich a single lead
// ============================================

export const enrichLead = async (lead) => {
  const base = {
    enrichment_status: 'not_attempted',
    enrichment_data: null,
    error: null,
  };

  const url = normaliseUrl(lead.website);
  if (!url) return { ...base, enrichment_status: 'no_website' };

  const domain = extractDomain(url);
  if (!domain) return { ...base, enrichment_status: 'invalid_url' };

  // Check cache first
  const cached = await checkCache(domain);
  if (cached) {
    return {
      enrichment_status: cached.enrichment_status,
      enrichment_data: cached.enrichment_data,
      error: cached.error,
      from_cache: true,
    };
  }

  // Not in cache — scrape
  console.log(`   🔍 Enriching ${domain}...`);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const { data, duration_ms, source_url } = await scrapeUrl(url, ENRICHMENT_SCHEMA, EXTRACTION_PROMPT);

      // Validate domain
      if (source_url && !isSameDomain(url, source_url)) {
        const result = {
          enrichment_status: 'domain_mismatch',
          enrichment_data: null,
          error: `Redirected to ${source_url}`,
        };
        await saveToCache(domain, url, result);
        return result;
      }

      if (isEmptyEnrichment(data)) {
        const result = {
          enrichment_status: 'failed_empty',
          enrichment_data: null,
          error: 'No usable data extracted',
        };
        await saveToCache(domain, url, result);
        return result;
      }

      // If no email found on homepage, try contact pages
      if (data && !data.contact?.email) {
        console.log(`   📧 No email on homepage — checking contact pages...`);
        const contactInfo = await tryContactPages(url);
        if (contactInfo) {
          data.contact = {
            email: contactInfo.email,
            phone: contactInfo.phone || data.contact?.phone || null,
          };
        }
      }

      const result = {
        enrichment_status: 'success',
        enrichment_data: data,
        error: null,
      };

      await saveToCache(domain, url, result);
      console.log(`   ✅ Enriched ${domain} in ${duration_ms}ms${data?.contact?.email ? ' (email found)' : ''}`);
      return result;

    } catch (err) {
      lastError = err;
      const message = err?.message ?? String(err);
      const isRetryable = /timeout|429|rate.limit|ECONN|network|fetch.failed/i.test(message);

      if (!isRetryable || attempt > MAX_RETRIES) {
        const status = /403|blocked|forbidden/i.test(message) ? 'blocked'
          : /timeout/i.test(message) ? 'timeout'
          : 'error';

        const result = {
          enrichment_status: status,
          enrichment_data: null,
          error: message,
        };
        await saveToCache(domain, url, result);
        return result;
      }

      const backoffMs = 2 ** attempt * 1000 + Math.random() * 500;
      console.log(`   ⏳ Retry ${attempt} for ${domain} in ${Math.round(backoffMs)}ms...`);
      await sleep(backoffMs);
    }
  }

  const result = {
    enrichment_status: 'error',
    enrichment_data: null,
    error: lastError?.message ?? 'Unknown error',
  };
  await saveToCache(domain, url, result);
  return result;
};

// ============================================
// BATCH ENRICHMENT
// ============================================

export const enrichLeadsBatch = async (leads, { concurrency = 3 } = {}) => {
  const results = new Map();
  const queue = [...leads];

  const worker = async () => {
    while (queue.length > 0) {
      const lead = queue.shift();
      if (!lead) continue;
      const result = await enrichLead(lead);
      results.set(lead.business_name, result);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, leads.length) }, () => worker())
  );

  return results;
};
