// src/emailWriter.js
// Two-stage lead qualification and email writing
// Uses three composable slots: TRADE_PROFILE + CONTAINER_RUBRIC + BUYER_VOICE
// Each slot is driven by config files — adding a new trade or container = config change only

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load configs once
let containerConfig = null;
let archetypeConfig = null;

async function loadContainerConfig() {
  if (containerConfig) return containerConfig;
  const raw = await readFile(path.join(__dirname, 'config', 'container_types.json'), 'utf8');
  const parsed = JSON.parse(raw);
  containerConfig = Object.fromEntries(parsed.containers.map(c => [c.id, c]));
  return containerConfig;
}

async function loadArchetypeConfig() {
  if (archetypeConfig) return archetypeConfig;
  const raw = await readFile(path.join(__dirname, 'config', 'buyer_archetypes.json'), 'utf8');
  const parsed = JSON.parse(raw);
  archetypeConfig = Object.fromEntries(parsed.archetypes.map(a => [a.id, a]));
  return archetypeConfig;
}

const sanitize = (str) => {
  if (!str) return '';
  return str
    .replace(/'/g, "'")
    .replace(/"/g, '"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .trim();
};

// ============================================
// SLOT BUILDERS
// ============================================

const buildTradeProfile = (client) => {
  const lines = [];
  lines.push(`- Business: ${sanitize(client.business_name || client.trade)}`);
  lines.push(`- Trade: ${sanitize(client.trade)}`);
  lines.push(`- Location: ${sanitize(client.location)}`);

  if (client.website_summary && client.website_summary.length > 10) {
    lines.push(`- What they do: ${sanitize(client.website_summary)}`);
  } else if (client.offering && client.offering.length > 10) {
    lines.push(`- What they do: ${sanitize(client.offering)}`);
  }

  if (client.recent_job && client.recent_job.length > 10) {
    lines.push(`- Recent proof point (rewrite naturally): ${sanitize(client.recent_job)}`);
  }

  if (client.work_types?.length > 0) {
    lines.push(`- Types of work: ${client.work_types.map(sanitize).join(', ')}`);
  }

  if (client.perfect_lead_def) {
    lines.push(`- Ideal client: ${sanitize(client.perfect_lead_def)}`);
  }

  return lines.join('\n');
};

const buildContainerRubric = (container) => {
  if (!container) return 'No container rubric available — score on general fit.';

  const lines = [`Container type: ${container.display_name}`];

  const signals = container.scoring_signals;
  if (signals) {
    if (signals.strong_positive?.length) {
      lines.push(`Strong positive signals (+2 each): ${signals.strong_positive.join('; ')}`);
    }
    if (signals.moderate_positive?.length) {
      lines.push(`Moderate positive signals (+1 each): ${signals.moderate_positive.join('; ')}`);
    }
    if (signals.negative?.length) {
      lines.push(`Negative signals (-1 each): ${signals.negative.join('; ')}`);
    }
    if (signals.disqualifying?.length) {
      lines.push(`Disqualifying (auto-pass): ${signals.disqualifying.join('; ')}`);
    }
  }

  return lines.join('\n');
};

const buildBuyerVoice = (archetype) => {
  if (!archetype) return 'Write professionally and directly. Respect their time.';

  const lines = [];
  lines.push(`You are writing to a ${archetype.display_name}.`);
  lines.push(`Typical titles: ${archetype.typical_titles?.join(', ')}`);
  lines.push(`What they care about: ${archetype.what_they_care_about?.join('; ')}`);
  lines.push(`Tone: ${archetype.tone}`);

  if (archetype.language_rules?.length) {
    lines.push(`Language rules: ${archetype.language_rules.join('; ')}`);
  }

  lines.push(`Refer to their end users as: ${archetype.end_user_vocabulary || 'clients'}`);
  lines.push(`CTA style: ${archetype.cta_style}`);

  return lines.join('\n');
};

const buildSignOff = (client) => {
  const lines = [sanitize(client.business_name || client.trade)];
  if (client.phone) lines.push(sanitize(client.phone));
  if (client.reply_email) lines.push(sanitize(client.reply_email));
  if (client.website) lines.push(sanitize(client.website));
  if (client.business_address) lines.push(sanitize(client.business_address));
  return lines.filter(Boolean).join('\n');
};

const buildRecipientContext = (lead) => {
  const lines = [`What you know about ${sanitize(lead.business_name)}:`];
  lines.push(`- Business type: ${sanitize(lead.container_type || lead.business_type || 'unknown')}`);
  lines.push(`- Location: ${sanitize(lead.city || 'unknown')}`);

  if (lead.enrichment_data) {
    const e = lead.enrichment_data;
    if (e.one_liner) lines.push(`- What they do: ${sanitize(e.one_liner)}`);
    if (e.services?.length) lines.push(`- Services: ${e.services.slice(0, 4).map(sanitize).join(', ')}`);
    if (e.specialisms?.length) lines.push(`- Specialisms: ${e.specialisms.map(sanitize).join(', ')}`);
    if (e.team_size_signal && e.team_size_signal !== 'unknown') lines.push(`- Team size: ${e.team_size_signal}`);
    if (e.decision_maker?.name) lines.push(`- Key person: ${sanitize(e.decision_maker.name)}${e.decision_maker.title ? `, ${sanitize(e.decision_maker.title)}` : ''}`);
    if (e.recent_projects?.length) lines.push(`- Recent projects: ${e.recent_projects.slice(0, 2).map(sanitize).join('; ')}`);

    if (e.personalization_hooks?.length) {
      lines.push('\nBest personalisation hooks — pick ONE and reference it naturally:');
      e.personalization_hooks.slice(0, 3).forEach(h => {
        if (h.hook) lines.push(`- ${sanitize(h.hook)}${h.source_quote ? ` (from their site: "${sanitize(h.source_quote)}")` : ''}`);
      });
      lines.push('Reference the angle not the quote. Make it feel like something you noticed.');
      lines.push('Avoid RAMS, ISO certifications, H&S policies or compliance language — too technical for a cold email.');
    }
  } else {
    lines.push(`- Limited data available — write based on what this type of organisation typically needs`);
  }

  return lines.join('\n');
};

const buildFeedbackExamples = (approved, archived) => {
  if (!approved?.length && !archived?.length) return '';
  let examples = '\n# CALIBRATION FROM PREVIOUS CAMPAIGNS\n';
  if (approved?.length) {
    examples += 'APPROVED (good leads):\n';
    approved.slice(0, 5).forEach(l => {
      examples += `- ${sanitize(l.business_name)} (${sanitize(l.container_type || l.business_type)}, ${sanitize(l.city)})\n`;
    });
  }
  if (archived?.length) {
    examples += 'ARCHIVED (rejected):\n';
    archived.slice(0, 5).forEach(l => {
      examples += `- ${sanitize(l.business_name)} (${sanitize(l.container_type || l.business_type)}, ${sanitize(l.city)})\n`;
    });
  }
  return examples;
};

// ============================================
// STAGE 1 — LEAD SCORING
// ============================================
export const scoreLead = async (client, lead, previousApprovedLeads = [], previousArchivedLeads = []) => {
  try {
    const containers = await loadContainerConfig();
    const container = containers[lead.container_type] || null;
    const containerRubric = buildContainerRubric(container);
    const feedbackExamples = buildFeedbackExamples(previousApprovedLeads, previousArchivedLeads);

    const enrichmentContext = lead.enrichment_data ? `
# ENRICHED WEBSITE DATA
- What they do: ${sanitize(lead.enrichment_data.one_liner || '')}
- Services: ${lead.enrichment_data.services?.map(sanitize).join(', ') || 'unknown'}
- Team size: ${lead.enrichment_data.team_size_signal || 'unknown'}
- Hooks available: ${lead.enrichment_data.personalization_hooks?.length || 0}` : '';

    const prompt = `You are a B2B lead qualification analyst. Score this prospect for the client below.

# CLIENT PROFILE
- Business: ${sanitize(client.business_name) || 'Unknown'}
- Trade: ${sanitize(client.trade)}
- Location: ${sanitize(client.location)}
- Ideal clients: ${client.ideal_clients?.map(sanitize).join(', ') || 'Not specified'}
- Work types: ${client.work_types?.map(sanitize).join(', ') || 'Not specified'}
- Perfect lead: ${sanitize(client.perfect_lead_def) || 'Not specified'}
- Disqualifiers: ${sanitize(client.disqualifiers) || 'None'}
- Volume vs precision (1=volume 5=precision): ${client.volume_vs_precision || 3}
${feedbackExamples}

# CONTAINER RUBRIC
${containerRubric}

# PROSPECT DATA
- Name: ${sanitize(lead.business_name)}
- Container type: ${sanitize(lead.container_type || lead.business_type || 'unknown')}
- Location: ${sanitize(lead.city || lead.address)}
- Website: ${sanitize(lead.website) || 'None'}
- Source: ${sanitize(lead.source)}
- Description: ${sanitize(lead.description) || 'None'}
${enrichmentContext}

SCORING RULES:
- Use the container rubric signals above to score
- Score 0-10, show your math
- Apply disqualifiers absolutely
- Check against perfect lead definition

Priority mapping for volume_vs_precision=${client.volume_vs_precision || 3}:
- 1-2: hot=7+, warm=4-6, cold=2-3, pass=0-1
- 3: hot=8+, warm=5-7, cold=2-4, pass=0-1
- 4-5: hot=9+, warm=6-8, cold=3-5, pass=0-2

Return ONLY valid JSON, double quotes only:
{
  "fit_score": 0,
  "fit_reason": "brief math explanation",
  "priority": "hot|warm|cold|pass",
  "top_signals": [],
  "disqualifiers_found": [],
  "matches_perfect_lead_def": false
}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text
      .replace(/```json|```/g, '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .trim();

    const result = JSON.parse(text);
    return {
      fit_score: Math.max(0, Math.min(100, (result.fit_score || 0) * 10)),
      fit_reason: result.fit_reason || 'No reason provided',
      matches_perfect_lead_def: result.matches_perfect_lead_def || false,
    };

  } catch (err) {
    console.error(`Scoring failed for ${lead.business_name}:`, err.message);
    let score = 40;
    if (lead.website) score += 10;
    if (lead.enrichment_data) score += 10;
    return { fit_score: score, fit_reason: 'Fallback scoring used', matches_perfect_lead_def: false };
  }
};

// ============================================
// STAGE 2 — EMAIL WRITING
// ============================================
export const writeEmail = async (client, lead) => {
  console.log(`✍️  Writing email for ${lead.business_name}...`);

  try {
    const archetypes = await loadArchetypeConfig();
    const archetype = archetypes[lead.buyer_archetype] || null;

    const tradeProfile = buildTradeProfile(client);
    const buyerVoice = buildBuyerVoice(archetype);
    const recipientContext = buildRecipientContext(lead);
    const signOff = buildSignOff(client);

    const prompt = `You are ${sanitize(client.business_name || client.trade)} writing a short cold outreach email.

# WHO YOU ARE (TRADE PROFILE)
${tradeProfile}

# WHO YOU ARE WRITING TO (BUYER VOICE)
${buyerVoice}

# WHAT YOU KNOW ABOUT THE RECIPIENT
${recipientContext}

# YOUR TASK
Write a short professional email introducing yourself to ${sanitize(lead.business_name)}.

RULES:
1. Open with "Hi, we are ${sanitize(client.business_name || client.trade)},"
2. First paragraph: one sentence — what you do and where you are based
3. Second paragraph: why you are contacting THIS specific organisation — use enrichment data if available, reference something specific. Never generic industry observations.
4. Third paragraph: one simple low-pressure ask
5. End with this sign-off:
${signOff}

LANGUAGE RULES:
- Describe work as facts never as qualities — say WHAT you do not HOW GOOD you are
- If an adjective describes your own work remove it
- Short sentences plain words no corporate waffle
- Match the buyer voice tone above

Subject line: plain and specific like "Joinery - Wolverhampton" or "${sanitize(client.trade)} - ${sanitize(lead.city || client.location)}"

Follow-up: one sentence to send 3 days later if no reply. Brief and natural. Match the buyer voice.

Return ONLY valid JSON, double quotes only:
{
  "subject": "subject line",
  "body": "full email with \\n for line breaks including sign-off",
  "follow_up": "one sentence follow up"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text
      .replace(/```json|```/g, '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .trim();

    const result = JSON.parse(text);
    return {
      email_subject: result.subject,
      email_body: result.body,
      follow_up_body: result.follow_up,
    };

  } catch (err) {
    console.error(`Email writing failed for ${lead.business_name}:`, err.message);
    const signOff = buildSignOff(client);
    return {
      email_subject: `${client.trade} - ${client.location}`,
      email_body: `Hi, we are ${sanitize(client.business_name || client.trade)},\n\nWe are a ${sanitize(client.trade)} based in ${sanitize(client.location)}. Would it be worth a quick conversation?\n\n${signOff}`,
      follow_up_body: `Just following up on my previous message - happy to chat if the timing works.`,
    };
  }
};
