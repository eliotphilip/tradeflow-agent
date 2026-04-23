// src/utils/enhanceClient.js
// Runs once per campaign — improves raw client profile data
// Fixes grammar, clarifies vague descriptions, sharpens targeting
// Also builds a similar_client_profile from any similar_client_urls using Firecrawl
// The enhanced profile is used for all downstream steps but never saved back to DB

import Anthropic from '@anthropic-ai/sdk';
import FirecrawlApp from '@mendable/firecrawl-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

// ============================================
// SIMILAR CLIENT PROFILE BUILDER
// ============================================

const SIMILAR_CLIENT_SCHEMA = {
  type: 'object',
  properties: {
    business_name: { type: 'string' },
    sector: {
      type: 'string',
      description: 'One word sector e.g. construction, hospitality, education, care, automotive, retail',
    },
    what_they_do: {
      type: 'string',
      description: 'One sentence description of what this business actually does. Facts only, no marketing language.',
    },
    size_signal: {
      type: 'string',
      enum: ['solo', 'small', 'medium', 'large', 'unknown'],
      description: 'solo=1, small=2-10, medium=11-50, large=50+',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: '3 to 6 keywords describing this type of business',
    },
    sic_code_hints: {
      type: 'array',
      items: { type: 'string' },
      description: 'UK SIC codes that likely apply e.g. 41100 for property development',
    },
    container_type_hints: {
      type: 'array',
      items: { type: 'string' },
      description: 'TradeFlow container types that match e.g. property_developer, hotel, care_home, main_contractor',
    },
    services: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific services listed on the site',
    },
    geographic_coverage: {
      type: 'string',
      enum: ['local', 'regional', 'national', 'unknown'],
    },
  },
  required: ['sector', 'what_they_do', 'keywords', 'sic_code_hints', 'container_type_hints'],
};

const SIMILAR_CLIENT_PROMPT = `
You are profiling a business website to understand what kind of company it is.
This profile will be used to find similar businesses for B2B lead generation.
Extract factual information only — do not invent anything not present on the page.

Rules:
- sector: one word, pick the most specific one that fits
- keywords: concrete terms someone would search to find this type of business
- sic_code_hints: UK SIC codes that apply — be specific, not generic
- container_type_hints: pick from this list only: property_developer, main_contractor, housing_association, facilities_management, architect, letting_agency, care_home, hospice, retirement_village, hotel, wedding_venue, school, boarding_school, nursery, corporate_office, fleet_operator, logistics_depot, taxi_firm, dealership, sports_club, residential_block, small_business, startup, retail_chain, professional_services
`.trim();

const scrapeWithFirecrawl = async (url) => {
  try {
    const normalised = url.startsWith('http') ? url : `https://${url}`;

    const result = await Promise.race([
      firecrawl.scrapeUrl(normalised, {
        formats: ['json'],
        jsonOptions: {
          prompt: SIMILAR_CLIENT_PROMPT,
          schema: SIMILAR_CLIENT_SCHEMA,
        },
        onlyMainContent: true,
        waitFor: 2000,
        timeout: 25000,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout after 30s')), 30000)
      ),
    ]);

    return result?.json ?? null;
  } catch (err) {
    console.log(`   ⚠️  Firecrawl failed for ${url}: ${err.message}`);
    return null;
  }
};

export const buildSimilarClientProfile = async (similarClientUrls) => {
  if (!similarClientUrls?.length) return null;
  if (!process.env.FIRECRAWL_API_KEY) {
    console.log('   ⚠️  No Firecrawl API key — skipping similar client profile');
    return null;
  }

  console.log(`\n🔗 Building similar client profile from ${similarClientUrls.length} URL(s)...`);

  const profiles = [];

  for (const url of similarClientUrls.slice(0, 5)) {
    const data = await scrapeWithFirecrawl(url);

    if (!data || !data.sector) {
      console.log(`   ⚠️  No usable data from ${url}`);
      continue;
    }

    profiles.push({ ...data, source_url: url });
    console.log(`   ✅ Profiled ${data.business_name || url} — ${data.sector} | SIC: [${(data.sic_code_hints || []).join(', ')}]`);
  }

  if (!profiles.length) return null;

  // Synthesise into a single profile
  const allKeywords = [...new Set(profiles.flatMap(p => p.keywords || []))];
  const allSicCodes = [...new Set(profiles.flatMap(p => p.sic_code_hints || []))];
  const allContainerTypes = [...new Set(profiles.flatMap(p => p.container_type_hints || []))];
  const allServices = [...new Set(profiles.flatMap(p => p.services || []))];
  const sectors = [...new Set(profiles.map(p => p.sector).filter(Boolean))];

  const similarClientProfile = {
    source_count: profiles.length,
    sectors,
    keywords: allKeywords,
    sic_codes: allSicCodes,
    container_type_hints: allContainerTypes,
    services: allServices.slice(0, 10),
    examples: profiles.map(p => ({
      url: p.source_url,
      name: p.business_name,
      what_they_do: p.what_they_do,
      sector: p.sector,
      size: p.size_signal,
      geographic_coverage: p.geographic_coverage,
    })),
  };

  console.log(`   📊 Profile: sectors=[${sectors.join(', ')}] | SIC=[${allSicCodes.join(', ')}] | containers=[${allContainerTypes.join(', ')}]`);
  return similarClientProfile;
};

// ============================================
// MAIN PROFILE ENHANCER
// ============================================

export const enhanceClientProfile = async (client) => {
  console.log(`\n✨ Enhancing client profile for ${client.business_name || client.trade}...`);

  try {
    const prompt = `You are helping a small business owner present themselves clearly and professionally.
They have filled in their profile but some fields may have grammar issues, be vague, or need tidying up.
Your job is to improve these fields so they are clear and professional.

RULES:
- Keep the EXACT same meaning — do NOT invent facts or add anything they did not say
- Fix grammar and spelling only
- Keep it natural — not corporate marketing speak
- Keep it concise
- If a field is already good, return it unchanged
- If a field is empty or null, return null

THEIR TRADE: ${client.trade}
THEIR LOCATION: ${client.location}
THEIR WORK DESCRIPTION: ${client.website_summary || ''}

FIELDS TO IMPROVE:

1. website_summary (their description of what they do):
Raw: "${client.website_summary || ''}"
Fix grammar and spelling only. Keep every fact they mentioned exactly as stated.
Do not add anything they did not say. Do not remove any services they mentioned.

2. offering (what makes them stand out):
Raw: "${client.offering || ''}"
Improve this to sound like a clear professional one-liner about what they do well.
Base it on their work description above if the offering field is vague or empty.

3. recent_job (a recent proof point):
Raw: "${client.recent_job || ''}"
Improve this to sound like a natural proof point — what they did and for whom.
Format: "Recently [what they did] for [type of client]"
Keep it factual — do not add outcomes or adjectives they did not mention.

4. perfect_lead_def (their ideal client in one sentence):
Raw: "${client.perfect_lead_def || ''}"
Fix grammar and spelling. Make it specific and clear. Keep the same intent.

5. disqualifiers (who they do NOT want to work with):
Raw: "${client.disqualifiers || ''}"
Fix grammar and spelling. Keep the same intent.

Return ONLY valid JSON, double quotes, no markdown:
{
  "website_summary": "cleaned up version or null",
  "offering": "improved text or null",
  "recent_job": "improved text or null",
  "perfect_lead_def": "improved text or null",
  "disqualifiers": "improved text or null"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text
      .replace(/```json|```/g, '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .trim();

    const enhanced = JSON.parse(text);
    const enhancedClient = { ...client };

    if (enhanced.website_summary) {
      console.log(`   ✅ website_summary cleaned`);
      enhancedClient.website_summary = enhanced.website_summary;
    }
    if (enhanced.offering) {
      console.log(`   ✅ offering: "${client.offering}" → "${enhanced.offering}"`);
      enhancedClient.offering = enhanced.offering;
    }
    if (enhanced.recent_job) {
      console.log(`   ✅ recent_job improved`);
      enhancedClient.recent_job = enhanced.recent_job;
    }
    if (enhanced.perfect_lead_def) {
      console.log(`   ✅ perfect_lead_def: "${client.perfect_lead_def}" → "${enhanced.perfect_lead_def}"`);
      enhancedClient.perfect_lead_def = enhanced.perfect_lead_def;
    }
    if (enhanced.disqualifiers) {
      console.log(`   ✅ disqualifiers improved`);
      enhancedClient.disqualifiers = enhanced.disqualifiers;
    }

    // Build similar client profile via Firecrawl if URLs provided
    if (client.similar_client_urls?.length) {
      enhancedClient.similar_client_profile = await buildSimilarClientProfile(client.similar_client_urls);
    }

    return enhancedClient;

  } catch (err) {
    console.error('Profile enhancement failed:', err.message);
    return client;
  }
};
