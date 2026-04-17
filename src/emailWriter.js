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
-3 Any hard disqualifier present
-2 Business is clearly irrelevant to a ${client.trade} (wrong industry entirely)
-1 Only surface-level match with no clear need

Final score: 0-10.

Priority mapping based on volume_vs_precision=${client.volume_vs_precision || 3}:
- If 1-2: hot=7+, warm=4-6, cold=2-3, pass=0-1
- If 3: hot=8+, warm=5-7, cold=2-4, pass=0-1
- If 4-5: hot=9+, warm=6-8, cold=3-5, pass=0-2

PERFECT LEAD CHECK:
Does this prospect match the client's perfect lead definition: "${client.perfect_lead_def || 'Not specified'}"?
Return true only if it genuinely matches.

Return ONLY valid JSON, no markdown:
{
  "fit_score": 0,
  "fit_reason": "brief explanation showing the math",
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
    // First, intelligently process the client's raw inputs
    // The agent rewrites/improves what the client told us rather than using it verbatim
    const clientContext = buildClientContext(client);

    const prompt = `You are an expert B2B copywriter. Write a cold outreach email on behalf of a small business owner.

# ABOUT THE SENDER
${clientContext}

# ABOUT THE RECIPIENT
- Business: ${lead.business_name}
- Type of business: ${lead.business_type}
- Location: ${lead.city || 'Unknown'}
- Website: ${lead.website || 'Not available'}
- Additional info: ${lead.description || 'Local business found via search'}
- Contact name: ${lead.contact_name ? lead.contact_name : 'Unknown — use "Hi" as greeting'}
- Is a perfect client match: ${lead.matches_perfect_lead_def ? 'YES' : 'No'}

# YOUR JOB
Write a cold email that sounds like the business owner typed it themselves between jobs.
NOT a marketing email. NOT corporate. A real person reaching out to another real person.

# STRICT RULES
1. Maximum 3 short paragraphs, under 100 words total
2. Para 1: Who you are in one sentence — trade + location + one specific thing you do well
3. Para 2: Why you're contacting THEM specifically — reference something real about their business type, not generic flattery. If perfect match, be very specific. Never say "I came across your business"
4. Para 3: Simple ask — available if they ever need someone, no pressure
5. Sign off: just the business name, nothing else
6. Subject: plain format like "Joinery — Wolverhampton" or "Joinery work — [their area]"
7. Follow-up: 1 sentence, casual, 3 days later — just checking if email was received, no pressure at all

# BANNED PHRASES — never use these
"I hope this finds you well", "I came across your business", "I'd love to", "passionate about", 
"game-changer", "synergy", "reach out", "touch base", "circle back", "excited to connect",
"fancy a coffee", "grab a coffee", "pick your brain", "leverage", "going forward",
"I was impressed by", "I love what you're doing", "amazing work"

# TONE GUIDE
${getToneGuide(client.tone)}

Return ONLY valid JSON, no markdown:
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
      follow_up_body: `Just following up on my previous message — let me know if it's worth a conversation.`,
    };
  }
};

// ============================================
// HELPERS
// ============================================

// Build a rich, intelligent context block from raw client data
// The agent improves and interprets what the client told us
const buildClientContext = (client) => {
  const lines = [];

  lines.push(`- Name/Business: ${client.business_name || client.trade}`);
  lines.push(`- Trade: ${client.trade}`);
  lines.push(`- Location: ${client.location}`);

  // Intelligently handle offering — improve if thin
  if (client.offering && client.offering.length > 10) {
    lines.push(`- What they do well: ${client.offering}`);
  } else {
    lines.push(`- What they do well: Reliable ${client.trade} work in ${client.location}`);
  }

  // Handle recent job — extract the key proof point
  if (client.recent_job && client.recent_job.length > 10) {
    lines.push(`- Recent proof point: ${client.recent_job} (use this naturally as social proof, rewrite it to sound natural — don't quote it verbatim)`);
  }

  // Work types
  if (client.work_types?.length > 0) {
    lines.push(`- Types of work: ${client.work_types.join(', ')}`);
  }

  // Perfect lead context
  if (client.perfect_lead_def) {
    lines.push(`- Their ideal client: ${client.perfect_lead_def}`);
  }

  return lines.join('\n');
};

// Convert tone preference to writing guidance
const getToneGuide = (tone) => {
  if (!tone) return 'Direct and professional. Short sentences. No fluff.';

  const toneMap = {
    'Direct and to the point': 'Very direct. Short sentences. No softening language. Get straight to the point.',
    'Friendly and approachable': 'Warm but professional. Conversational. Like a friendly colleague, not a salesperson.',
    'Professional and formal': 'Professional tone. No contractions. Clear and respectful. Slightly more formal than casual.',
    'Peer-to-peer': 'Like texting a colleague. Very casual. Contractions fine. Short punchy sentences.',
    'Confident and assertive': 'Confident, not arrogant. States value clearly. No hedging or apologetic language.',
    'Understated and dry': 'Minimal. Dry. British understatement. Say less, imply more. No enthusiasm.',
  };

  // Handle comma-separated multiple tones
  const tones = tone.split(',').map(t => t.trim());
  const guides = tones.map(t => toneMap[t] || t).filter(Boolean);
  return guides.join(' + ');
};

// Build few-shot examples from feedback loop data
const buildFeedbackExamples = (approved, archived) => {
  if (approved.length === 0 && archived.length === 0) return '';

  let examples = '\n# CALIBRATION FROM PREVIOUS CAMPAIGNS\n';
  examples += 'Use these real decisions to calibrate your scoring:\n';

  if (approved.length > 0) {
    examples += '\nAPPROVED (good leads this client wanted):\n';
    approved.slice(0, 5).forEach(l => {
      examples += `- ${l.business_name} (${l.business_type}, ${l.city})\n`;
    });
  }

  if (archived.length > 0) {
    examples += '\nARCHIVED (leads this client rejected):\n';
    archived.slice(0, 5).forEach(l => {
      examples += `- ${l.business_name} (${l.business_type}, ${l.city})\n`;
    });
  }

  return examples;
};
