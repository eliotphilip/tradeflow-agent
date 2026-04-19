// src/utils/enhanceClient.js
// Runs once per campaign — takes raw client profile data and improves it
// Fixes grammar, clarifies vague descriptions, sharpens targeting
// The enhanced profile is used for all downstream steps but never saved back to DB

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const enhanceClientProfile = async (client) => {
  console.log(`\n✨ Enhancing client profile for ${client.business_name || client.trade}...`);

  try {
    const prompt = `You are helping a small business owner present themselves professionally.
They have filled in their profile but some fields are rough, vague, or have grammar issues.
Your job is to improve these fields so they sound professional and clear.

RULES:
- Keep the same meaning — do NOT invent facts or add things they did not say
- Fix grammar and spelling
- Make it sound professional but still like a real person, not corporate marketing
- Keep it concise — do not pad or over-explain
- If a field is already good, return it unchanged
- If a field is empty or null, return null

THEIR TRADE: ${client.trade}
THEIR LOCATION: ${client.location}

FIELDS TO IMPROVE:

1. offering (what makes them stand out):
Raw: "${client.offering || ''}"
Improve this to sound like a clear, professional one-liner about what they do well.

2. recent_job (a recent proof point):
Raw: "${client.recent_job || ''}"
Improve this to sound like a natural proof point — what they did, for whom, and the result.
Format: "Recently [what they did] for [type of client] — [brief positive outcome]"

3. perfect_lead_def (their ideal client in one sentence):
Raw: "${client.perfect_lead_def || ''}"
Improve this to be a clear, specific targeting statement with no typos.

4. disqualifiers (who they do NOT want to work with):
Raw: "${client.disqualifiers || ''}"
Improve this to be clear and specific if needed. Keep the same intent.

Return ONLY valid JSON, double quotes, no markdown:
{
  "offering": "improved text or null",
  "recent_job": "improved text or null",
  "perfect_lead_def": "improved text or null",
  "disqualifiers": "improved text or null"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text
      .replace(/```json|```/g, '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .trim();

    const enhanced = JSON.parse(text);

    // Merge enhanced fields back into client — only override if improvement exists
    const enhancedClient = { ...client };

    if (enhanced.offering) {
      console.log(`   ✅ offering: "${client.offering}" → "${enhanced.offering}"`);
      enhancedClient.offering = enhanced.offering;
    }
    if (enhanced.recent_job) {
      console.log(`   ✅ recent_job: "${client.recent_job}" → "${enhanced.recent_job}"`);
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
    // Return original client unchanged — never crash the pipeline
    return client;
  }
};
