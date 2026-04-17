// src/emailWriter.js
// Two-stage lead qualification and email writing system
// Stage 1: Score and qualify the lead (Haiku - fast, cheap)
// Stage 2: Write personalised outreach (Haiku with rich context)

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ============================================
// STAGE 1 — LEAD QUALIFICATION & SCORING
// ============================================
export const scoreLead = async (client, lead, previousApprovedLeads = [], previousArchivedLeads = []) => {
  try {
    // Build few-shot examples from feedback loop data
    const feedbackExamples = buildFeedbackExamples(previousApprovedLeads, previousArchivedLeads);

    const prompt = `You are a B2B lead qualification analyst. Score this prospect for the client below.

# CLIENT PROFILE
- Business: ${client.business_name || 'Unknown'}
- Trade/Service: ${client.trade}
- Location: ${client.location}
- What they do: ${client.offering || 'Not specified'}
- Ideal clients: ${client.ideal_clients?.join(', ') || 'Not specified'}
- Target client size: ${client.client_size || 'Any'}
- Work types wanted: ${client.work_types?.join(', ') || 'Not specified'}
- Perfect lead definition: ${client.perfect_lead_def || 'Not specified'}
- Hard disqualifiers: ${client.disqualifiers || 'None specified'}
- Volume vs precision (1=volume, 5=precision): ${client.volume_vs_precision || 3}
${feedbackExamples}

# PROSPECT DATA
- Business name: ${lead.business_name}
- Type: ${lead.business_type}
- Location: ${lead.city || lead.address}
- Website: ${lead.website || 'None'}
- Source: ${lead.source}
- Description: ${lead.description || 'None'}

# SCORING RUBRIC — add points only when evidence exists

FIRMOGRAPHIC FIT (max 3):
+1 Business type matches ideal clients
+1 Location is within client's area
+1 Business size appears to match target client size

RELEVANCE (max 3):
+1 Business would logically need the client's trade/service
+1 Business type aligns with client's work types
+1 Lead source and business type suggest active market

QUALITY (max 2):
+1 Has a website (more established)
+1 Business name/type suggests a real decision-maker exists

PENALTIES:
-3 Any hard disqualifier present — near automatic low score
-2 Business is clearly irrelevant to a ${client.trade} (wrong industry entirely)
-1 Only surface-level match with no clear need

Final score: 0-10.

Priority mapping based on volume_vs_precision=${client.volume_vs_precision || 3}:
- If 1-2: hot=7+, warm=4-6, cold=2-3, pass=0-1
- If 3: hot=8+, warm=5-7, cold=2-4, pass=0-1
- If 4-5: hot=9+, warm=6-8, cold=3-5, pass=0-2

PERFECT LEAD CHECK:
Does this prospect match the client's perfect lead definition: "${client.perfect_lead_def || 'Not specified'}"?
Return true only if it genuinely matches — not just a decent lead.

Return ONLY valid JSON, no markdown:
{
  "fit_score": 0,
  "fit_reason": "brief explanation showing the math e.g. +1 type match, +1 location, -2 irrelevant = 0",
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

    const text = response.content[0].text.replace(/```json|```/g, '').trim();
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
    if (lead.city?.toLowerCase().includes(client.location?.toLowerCase())) score += 20;
    return {
      fit_score: score,
      fit_reason: 'Fallback scoring used',
      matches_perfect_lead_def: false,
    };
  }
};

// ============================================
// STAGE 2 — PERSONALISED EMAIL WRITING
// ============================================
export const writeEmail = async (client, lead) => {
  console.log(`✍️  Writing email for ${lead.business_name}...`);

  try {
    const prompt = `You are a senior B2B copywriter writing a cold outreach email on behalf of a business owner.

# WHO IS SENDING THIS EMAIL
- Business: ${client.business_name || client.trade}
- Trade/Service: ${client.trade}
- Location: ${client.location}
- What makes them stand out: ${client.offering || 'Not specified'}
- Tone preference: ${client.tone || 'Direct and to the point'}
- Recent work example: ${client.recent_job || 'Not specified'}
- Perfect client definition: ${client.perfect_lead_def || 'Not specified'}

# WHO IS RECEIVING THIS EMAIL
- Business: ${lead.business_name}
- Type: ${lead.business_type}
- Location: ${lead.city || lead.address}
- Website: ${lead.website || 'None found'}
- What we know: ${lead.description || 'Local business'}
- Contact name: ${lead.contact_name || 'Unknown'}
- Is a perfect lead match: ${lead.matches_perfect_lead_def ? 'YES — mention something specific' : 'No — keep it general'}

# WRITING RULES
1. Write in first person as the business owner — natural, human, not corporate
2. 3 short paragraphs maximum
3. Para 1: One sentence — who you are and what you do
4. Para 2: Connect their business to your service — if perfect match, be specific
5. Para 3: Simple low-pressure ask
6. Sign off with just the business name
7. Subject: plain and specific e.g. "Joinery — Wolverhampton"
8. BANNED words/phrases: "I hope this finds you well", "I came across", "I'd love to", "passionate", "game-changer", "synergy", "reach out", "touch base", "circle back", "excited to"
9. Tone: ${client.tone || 'direct and to the point'}
10. Under 100 words total
11. Sound like a real person typing between jobs — not a marketing email

# FOLLOW UP
1-2 sentences, casual, 3 days later. Even shorter than the email.

Return ONLY valid JSON, no markdown:
{
  "subject": "email subject line",
  "body": "full email body with \\n for line breaks",
  "follow_up": "short follow up"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(text);

    return {
      email_subject: result.subject,
      email_body: result.body,
      follow_up_body: result.follow_up,
    };

  } catch (err) {
    console.error(`Email writing failed for ${lead.business_name}:`, err.message);
    return {
      email_subject: `${client.trade} — ${client.location}`,
      email_body: `Hi,\n\nI'm a ${client.trade} based in ${client.location}.\n\nWould you be open to a quick conversation?\n\n${client.business_name || client.trade}`,
      follow_up_body: `Just following up on my previous email. Let me know if it's worth a conversation.`,
    };
  }
};

// ============================================
// HELPERS
// ============================================

// Build few-shot examples from previous approved/archived leads
const buildFeedbackExamples = (approved, archived) => {
  if (approved.length === 0 && archived.length === 0) return '';

  let examples = '\n# CALIBRATION FROM PREVIOUS CAMPAIGNS\n';
  examples += 'Use these to calibrate your scoring — these are real decisions this client made:\n';

  if (approved.length > 0) {
    examples += '\nAPPROVED (good leads):\n';
    approved.slice(0, 5).forEach(l => {
      examples += `- ${l.business_name} (${l.business_type}, ${l.city}) → Client approved this\n`;
    });
  }

  if (archived.length > 0) {
    examples += '\nARCHIVED (not relevant):\n';
    archived.slice(0, 5).forEach(l => {
      examples += `- ${l.business_name} (${l.business_type}, ${l.city}) → Client archived this\n`;
    });
  }

  return examples;
};
