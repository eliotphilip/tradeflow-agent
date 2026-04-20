// src/utils/enhanceClient.js
// Runs once per campaign — improves raw client profile data
// Fixes grammar, clarifies vague descriptions, sharpens targeting
// The enhanced profile is used for all downstream steps but never saved back to DB

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

    return enhancedClient;

  } catch (err) {
    console.error('Profile enhancement failed:', err.message);
    return client;
  }
};
