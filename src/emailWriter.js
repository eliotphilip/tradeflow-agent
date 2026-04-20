// src/emailWriter.js
// Two-stage lead qualification and email writing system
// Stage 1: Score and qualify the lead (Haiku)
// Stage 2: Write email AS the business owner — professional, human, no waffle

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

ENRICHMENT BONUS (max 2, only if enrichment available):
+1 Enrichment confirms strong fit with specific services
+1 Personalization hooks found

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
    const identity = buildIdentity(client);
    const recipientContext = buildRecipientContext(lead);
    const signOff = buildSignOff(client);

    const prompt = `${identity}

You are writing a short email to ${sanitize(lead.business_name)}.

${recipientContext}

Write the email now. 3 short paragraphs. Under 80 words for the body.

First line must be: "Hi, we are ${sanitize(client.business_name || client.trade)}," — always "Hi," never "Hi [name],"

Second paragraph: why you are contacting THIS specific business.${lead.enrichment_data ? ' You have real information about them from their website — use it. Reference something specific. Do not make general observations about their industry.' : ' Be realistic about what they likely need — do not make things up.'}

Third paragraph: one simple, low-pressure ask.

End with:
${signOff}

Subject: plain and specific, like "Joinery - Wolverhampton" or "${sanitize(client.trade)} - ${sanitize(lead.city || client.location)}"

Follow-up: one sentence to send 3 days later if no reply. Brief and natural.

Return ONLY valid JSON, double quotes only:
{
  "subject": "subject line",
  "body": "full email with \\n for line breaks, including sign-off",
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
    return {
      email_subject: `${client.trade} - ${client.location}`,
      email_body: `Hi, we are ${sanitize(client.business_name || client.trade)},\n\nWe are a ${sanitize(client.trade)} based in ${sanitize(client.location)}. Would it be worth a quick conversation?\n\n${buildSignOff(client)}`,
      follow_up_body: `Just following up on my previous message — happy to chat if the timing works.`,
    };
  }
};

// ============================================
// HELPERS
// ============================================

const buildIdentity = (client) => {
  const name = sanitize(client.business_name || client.trade);
  const trade = sanitize(client.trade);
  const location = sanitize(client.location);
  const isLocal = client.location_radius && client.location_radius < 100;

  // website_summary is the most specific description — use it as primary context
  const workDescription = client.website_summary && client.website_summary.length > 10
    ? sanitize(client.website_summary)
    : null;

  const offering = client.offering && client.offering.length > 10
    ? sanitize(client.offering)
    : `${trade} work`;

  const recentWork = client.recent_job && client.recent_job.length > 10
    ? `A recent example of your work: ${sanitize(client.recent_job)}.`
    : '';

  const workTypes = client.work_types?.length > 0
    ? `You typically work on: ${client.work_types.map(sanitize).join(', ')}.`
    : '';

  const geography = isLocal
    ? `You are based in ${location} and work within a ${client.location_radius} mile radius.`
    : `You are based in ${location} and work nationally.`;

  const toneDescription = getToneDescription(client.tone);

  return `You are ${name} — a ${trade} based in ${location}.
${workDescription ? `This is how you describe your own work: "${workDescription}"` : `You do: ${offering}.`}
${workTypes}
${recentWork}
${geography}

You are writing a short professional email to introduce yourself to a potential client.

Your writing style:
- Confident in your work, no need to oversell it
- Clear and direct — short sentences, plain words
- Professional but human — not corporate, not overly casual
- You respect the recipient's time so you keep it brief
- You sound like a capable business owner making a straightforward introduction

ONE RULE FOR LANGUAGE: Describe work as facts, never as qualities.
Say WHAT you do, not HOW GOOD you are at it.
If an adjective is describing your own work — remove it and just state the fact instead.
"We make and fit wooden doors and windows" is better than "we deliver precision-crafted joinery solutions".

GREETING RULE: Always open with "Hi," — never use a contact name, it might be wrong.

${toneDescription}`;
};

const buildRecipientContext = (lead) => {
  const lines = [`What you know about ${sanitize(lead.business_name)}:`];
  lines.push(`- Business type: ${sanitize(lead.business_type)}`);
  lines.push(`- Location: ${sanitize(lead.city || 'unknown')}`);

  if (lead.enrichment_data) {
    const e = lead.enrichment_data;

    if (e.one_liner) {
      lines.push(`- What they do: ${sanitize(e.one_liner)}`);
    }
    if (e.services?.length > 0) {
      lines.push(`- Their services: ${e.services.slice(0, 4).map(sanitize).join(', ')}`);
    }
    if (e.specialisms?.length > 0) {
      lines.push(`- They specialise in: ${e.specialisms.map(sanitize).join(', ')}`);
    }
    if (e.team_size_signal && e.team_size_signal !== 'unknown') {
      lines.push(`- Team size: ${e.team_size_signal}`);
    }
    if (e.decision_maker?.name) {
      lines.push(`- Key person: ${sanitize(e.decision_maker.name)}${e.decision_maker.title ? `, ${sanitize(e.decision_maker.title)}` : ''}`);
    }
    if (e.recent_projects?.length > 0) {
      lines.push(`- Recent projects: ${e.recent_projects.slice(0, 2).map(sanitize).join('; ')}`);
    }

    if (e.personalization_hooks?.length > 0) {
      lines.push(`\nSpecific things you noticed about them — pick ONE to reference naturally in your email:`);
      e.personalization_hooks.slice(0, 3).forEach((h) => {
        if (h.hook) {
          lines.push(`- ${sanitize(h.hook)}${h.source_quote ? ` (their words: "${sanitize(h.source_quote)}")` : ''}`);
        }
      });
      lines.push(`Important: reference the angle, not the quote. Make it feel like something you noticed, not something you read. Avoid referencing highly technical, regulatory or compliance-specific language from their website (e.g. RAMS, ISO certifications, H&S policies). These make the email feel like you scraped their site. Instead reference what they actually do or build.`);
    }
  } else {
    lines.push(`- No website data available`);
    lines.push(`- Write based on what a ${sanitize(lead.business_type)} business typically needs`);
  }

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

const getToneDescription = (tone) => {
  if (!tone) return '';

  const toneMap = {
    'Direct and to the point': 'You are direct. You get to the point quickly. No unnecessary words.',
    'Friendly and approachable': 'You are warm and easy to talk to. Professional but not stiff.',
    'Professional and formal': 'You are measured and professional. You choose words carefully.',
    'Peer-to-peer': 'You write as one professional to another. No hierarchy, just a straight conversation.',
    'Confident and assertive': 'You are confident in what you offer. You state things clearly without hedging.',
    'Understated and dry': 'You are understated. You say what you mean without dressing it up.',
  };

  const tones = tone.split(',').map(t => t.trim());
  const descriptions = tones.map(t => toneMap[t] || '').filter(Boolean);
  return descriptions.length > 0 ? descriptions.join(' ') : '';
};

const buildEnrichmentContext = (enrichmentData) => {
  if (!enrichmentData) return '';
  const lines = ['\n# ENRICHED WEBSITE DATA'];
  if (enrichmentData.one_liner) lines.push(`- What they do: ${sanitize(enrichmentData.one_liner)}`);
  if (enrichmentData.services?.length > 0) lines.push(`- Services: ${enrichmentData.services.map(sanitize).join(', ')}`);
  if (enrichmentData.team_size_signal) lines.push(`- Team size: ${enrichmentData.team_size_signal}`);
  if (enrichmentData.personalization_hooks?.length > 0) lines.push(`- Hooks available: ${enrichmentData.personalization_hooks.length}`);
  return lines.join('\n');
};

const buildFeedbackExamples = (approved, archived) => {
  if (approved.length === 0 && archived.length === 0) return '';
  let examples = '\n# CALIBRATION FROM PREVIOUS CAMPAIGNS\n';
  if (approved.length > 0) {
    examples += 'APPROVED:\n';
    approved.slice(0, 5).forEach(l => {
      examples += `- ${sanitize(l.business_name)} (${sanitize(l.business_type)}, ${sanitize(l.city)})\n`;
    });
  }
  if (archived.length > 0) {
    examples += 'ARCHIVED:\n';
    archived.slice(0, 5).forEach(l => {
      examples += `- ${sanitize(l.business_name)} (${sanitize(l.business_type)}, ${sanitize(l.city)})\n`;
    });
  }
  return examples;
};
