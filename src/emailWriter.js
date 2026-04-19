// src/emailWriter.js
// Two-stage lead qualification and email writing system
// Stage 1: Score and qualify the lead (Haiku)
// Stage 2: Write personalised outreach using enrichment data (Haiku)

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
// STAGE 1 — LEAD SCORING
// ============================================
export const scoreLead = async (client, lead, previousApprovedLeads = [], previousArchivedLeads = []) => {
  try {
    const feedbackExamples = buildFeedbackExamples(previousApprovedLeads, previousArchivedLeads);

    // Build enrichment context if available
    const enrichmentContext = lead.enrichment_data
      ? buildEnrichmentContext(lead.enrichment_data)
      : '';

    const prompt = `You are a B2B lead qualification analyst. Score this prospect for the client below.

# CLIENT PROFILE
- Business: ${sanitize(client.business_name) || 'Unknown'}
- Trade/Service: ${sanitize(client.trade)}
- Location: ${sanitize(client.location)}
- What they do well: ${sanitize(client.offering) || 'Not specified'}
- Ideal clients: ${client.ideal_clients?.map(sanitize).join(', ') || 'Not specified'}
- Target client size: ${sanitize(client.client_size) || 'Any'}
- Work types wanted: ${client.work_types?.map(sanitize).join(', ') || 'Not specified'}
- Perfect lead definition: ${sanitize(client.perfect_lead_def) || 'Not specified'}
- Hard disqualifiers: ${sanitize(client.disqualifiers) || 'None specified'}
- Volume vs precision (1=volume, 5=precision): ${client.volume_vs_precision || 3}
${feedbackExamples}

# PROSPECT DATA
- Business name: ${sanitize(lead.business_name)}
- Type: ${sanitize(lead.business_type)}
- Location: ${sanitize(lead.city) || sanitize(lead.address)}
- Website: ${sanitize(lead.website) || 'None'}
- Source: ${sanitize(lead.source)}
- Description: ${sanitize(lead.description) || 'None'}
${enrichmentContext}

# SCORING RUBRIC

FIRMOGRAPHIC FIT (max 3):
+1 Business type matches ideal clients
+1 Location is within client area
+1 Business size matches target

RELEVANCE (max 3):
+1 Business would logically need this trade
+1 Business type aligns with work types wanted
+1 Active market signal

QUALITY (max 2):
+1 Has a website
+1 Real decision-maker likely exists

ENRICHMENT BONUS (max 2, only if enrichment_data available):
+1 Enrichment confirms strong fit with specific services or projects
+1 Personalization hooks found — email can be highly specific

PENALTIES:
-3 Hard disqualifier present
-2 Clearly irrelevant to a ${sanitize(client.trade)}
-1 Only surface-level match

Score 0-10. Priority for volume_vs_precision=${client.volume_vs_precision || 3}:
- 1-2: hot=7+, warm=4-6, cold=2-3, pass=0-1
- 3: hot=8+, warm=5-7, cold=2-4, pass=0-1
- 4-5: hot=9+, warm=6-8, cold=3-5, pass=0-2

Does this match: "${sanitize(client.perfect_lead_def) || 'Not specified'}"?

Return ONLY valid JSON, double quotes only, no apostrophes in values:
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
    if (lead.city?.toLowerCase().includes(client.location?.toLowerCase())) score += 20;
    return { fit_score: score, fit_reason: 'Fallback scoring used', matches_perfect_lead_def: false };
  }
};

// ============================================
// STAGE 2 — EMAIL WRITING
// ============================================
export const writeEmail = async (client, lead) => {
  console.log(`✍️  Writing email for ${lead.business_name}...`);

  try {
    const clientContext = buildClientContext(client);
    const enrichmentSection = lead.enrichment_data
      ? buildEmailEnrichmentSection(lead.enrichment_data)
      : '- No website data available — write based on business type only';

    const prompt = `You are an expert B2B copywriter writing a cold outreach email for a small business owner.

# ABOUT THE SENDER
${clientContext}

# ABOUT THE RECIPIENT
- Business: ${sanitize(lead.business_name)}
- Type: ${sanitize(lead.business_type)}
- Location: ${sanitize(lead.city) || 'Unknown'}
- Contact: ${lead.contact_name ? sanitize(lead.contact_name) : 'Unknown - use Hi'}
- Is perfect match: ${lead.matches_perfect_lead_def ? 'YES - be very specific' : 'No'}

# WHAT WE KNOW ABOUT THIS BUSINESS (from their website)
${enrichmentSection}

# WRITING RULES
1. Max 3 short paragraphs, under 100 words total
2. Para 1: Who you are — trade + location + one specific thing you do well
3. Para 2: Why contacting THEM — use a specific detail from their website if available. If enrichment has personalization_hooks, use the best one. Never say "I came across your business"
4. Para 3: Simple low-pressure ask
5. Sign off: just the business name
6. Subject: plain format like "Joinery - Wolverhampton"
7. Follow-up: 1 sentence, casual, 3 days later

BANNED: "I hope this finds you well", "I came across", "I would love to",
"passionate", "game-changer", "synergy", "reach out", "touch base",
"circle back", "excited to connect", "fancy a coffee", "grab a coffee",
"pick your brain", "amazing work", "our work speaks for itself",
"quality is non-negotiable"

TONE: ${getToneGuide(client.tone)}

Return ONLY valid JSON, double quotes only:
{
  "subject": "plain subject line",
  "body": "email body with \\n for paragraph breaks",
  "follow_up": "one casual sentence follow up"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
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
    return {
      email_subject: `${client.trade} - ${client.location}`,
      email_body: `Hi,\n\nI am a ${client.trade} based in ${client.location}.\n\nWould you be open to a quick conversation?\n\n${client.business_name || client.trade}`,
      follow_up_body: `Just following up on my previous message - let me know if it is worth a conversation.`,
    };
  }
};

// ============================================
// HELPERS
// ============================================

const buildClientContext = (client) => {
  const lines = [];
  lines.push(`- Business: ${sanitize(client.business_name) || sanitize(client.trade)}`);
  lines.push(`- Trade: ${sanitize(client.trade)}`);
  lines.push(`- Location: ${sanitize(client.location)}`);

  if (client.offering && client.offering.length > 10) {
    lines.push(`- What they do well: ${sanitize(client.offering)}`);
  } else {
    lines.push(`- What they do well: Reliable ${sanitize(client.trade)} work in ${sanitize(client.location)}`);
  }

  if (client.recent_job && client.recent_job.length > 10) {
    lines.push(`- Recent proof point (rewrite naturally): ${sanitize(client.recent_job)}`);
  }

  if (client.work_types?.length > 0) {
    lines.push(`- Work types: ${client.work_types.map(sanitize).join(', ')}`);
  }

  if (client.perfect_lead_def) {
    lines.push(`- Ideal client: ${sanitize(client.perfect_lead_def)}`);
  }

  return lines.join('\n');
};

// Build enrichment context for scoring prompt
const buildEnrichmentContext = (enrichmentData) => {
  if (!enrichmentData) return '';

  const lines = ['\n# ENRICHED WEBSITE DATA'];

  if (enrichmentData.one_liner) {
    lines.push(`- What they actually do: ${sanitize(enrichmentData.one_liner)}`);
  }
  if (enrichmentData.services?.length > 0) {
    lines.push(`- Services: ${enrichmentData.services.map(sanitize).join(', ')}`);
  }
  if (enrichmentData.team_size_signal) {
    lines.push(`- Team size: ${enrichmentData.team_size_signal}`);
  }
  if (enrichmentData.geographic_coverage) {
    lines.push(`- Coverage: ${enrichmentData.geographic_coverage}`);
  }
  if (enrichmentData.personalization_hooks?.length > 0) {
    lines.push(`- Personalization hooks available: ${enrichmentData.personalization_hooks.length}`);
  }

  return lines.join('\n');
};

// Build enrichment section for email writing prompt
const buildEmailEnrichmentSection = (enrichmentData) => {
  if (!enrichmentData) return '- No data available';

  const lines = [];

  if (enrichmentData.one_liner) {
    lines.push(`- What they do: ${sanitize(enrichmentData.one_liner)}`);
  }
  if (enrichmentData.services?.length > 0) {
    lines.push(`- Their services: ${enrichmentData.services.slice(0, 4).map(sanitize).join(', ')}`);
  }
  if (enrichmentData.specialisms?.length > 0) {
    lines.push(`- Specialisms: ${enrichmentData.specialisms.map(sanitize).join(', ')}`);
  }
  if (enrichmentData.team_size_signal && enrichmentData.team_size_signal !== 'unknown') {
    lines.push(`- Team size: ${enrichmentData.team_size_signal}`);
  }
  if (enrichmentData.decision_maker?.name) {
    lines.push(`- Decision maker: ${sanitize(enrichmentData.decision_maker.name)}, ${sanitize(enrichmentData.decision_maker.title)}`);
  }
  if (enrichmentData.recent_projects?.length > 0) {
    lines.push(`- Recent projects: ${enrichmentData.recent_projects.slice(0, 3).map(sanitize).join('; ')}`);
  }
  if (enrichmentData.awards_certifications?.length > 0) {
    lines.push(`- Awards/certs: ${enrichmentData.awards_certifications.slice(0, 2).map(sanitize).join(', ')}`);
  }
  if (enrichmentData.contact?.email) {
    lines.push(`- Contact email found: ${sanitize(enrichmentData.contact.email)}`);
  }

  // Most important — personalization hooks
  if (enrichmentData.personalization_hooks?.length > 0) {
    lines.push(`\nPERSONALIZATION HOOKS (use the best one in para 2):`);
    enrichmentData.personalization_hooks.slice(0, 3).forEach(h => {
      if (h.hook && h.source_quote) {
        lines.push(`- Hook: "${sanitize(h.hook)}" (from site: "${sanitize(h.source_quote)}")`);
      }
    });
  }

  return lines.length > 0 ? lines.join('\n') : '- No useful data extracted from website';
};

const getToneGuide = (tone) => {
  if (!tone) return 'Direct and professional. Short sentences. No fluff.';

  const toneMap = {
    'Direct and to the point': 'Very direct. Short sentences. No softening. Get straight to the point.',
    'Friendly and approachable': 'Warm but professional. Conversational. Like a friendly colleague.',
    'Professional and formal': 'Professional tone. No contractions. Clear and respectful.',
    'Peer-to-peer': 'Like texting a colleague. Very casual. Short punchy sentences.',
    'Confident and assertive': 'Confident, not arrogant. States value clearly. No hedging.',
    'Understated and dry': 'Minimal. Dry. British understatement. Say less, imply more.',
  };

  const tones = tone.split(',').map(t => t.trim());
  return tones.map(t => toneMap[t] || t).filter(Boolean).join(' + ');
};

const buildFeedbackExamples = (approved, archived) => {
  if (approved.length === 0 && archived.length === 0) return '';

  let examples = '\n# CALIBRATION FROM PREVIOUS CAMPAIGNS\n';

  if (approved.length > 0) {
    examples += 'APPROVED leads:\n';
    approved.slice(0, 5).forEach(l => {
      examples += `- ${sanitize(l.business_name)} (${sanitize(l.business_type)}, ${sanitize(l.city)})\n`;
    });
  }

  if (archived.length > 0) {
    examples += 'ARCHIVED leads:\n';
    archived.slice(0, 5).forEach(l => {
      examples += `- ${sanitize(l.business_name)} (${sanitize(l.business_type)}, ${sanitize(l.city)})\n`;
    });
  }

  return examples;
};
