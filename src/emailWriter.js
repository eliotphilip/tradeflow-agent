// src/emailWriter.js
// Uses Claude to write personalised cold emails for each lead

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Write a personalised email for a single lead
export const writeEmail = async (client, lead) => {
  console.log(`✍️  Writing email for ${lead.business_name}...`);

  const prompt = `You are writing a cold outreach email on behalf of a tradesperson looking for work.

ABOUT THE TRADESPERSON (who the email is FROM):
- Trade: ${client.trade}
- Business name: ${client.business_name || 'their business'}
- Location: ${client.location}
- Business size: ${client.business_size}
- Work they want: ${client.work_types?.join(', ')}
- Recent job example: ${client.recent_job}
- Their website: ${client.website || 'none'}
${client.website_summary ? `- About their business: ${client.website_summary}` : ''}

ABOUT THE LEAD (who the email is TO):
- Business name: ${lead.business_name}
- Contact name: ${lead.contact_name || 'their team'}
- Business type: ${lead.business_type}
- Location: ${lead.city}
- Their website: ${lead.website || 'not available'}
- What we know about them: ${lead.description || 'local business'}

IMPORTANT RULES:
- Write in first person as the tradesperson
- Sound like a REAL HUMAN wrote this, not AI
- Keep it SHORT - 4 short paragraphs max
- Reference something specific about the lead's business if possible
- The recent job is social proof - use it naturally, don't force it
- Soft CTA - suggest a quick call or chat, never a hard sell
- Use [First Name] as placeholder if we don't have their name
- Match the tone to the business size - sole trader = craftsman tone, larger = professional tone
- NO buzzwords, NO "I hope this email finds you well", NO corporate speak
- Sign off with the tradesperson's first name only

Return ONLY a JSON object, no markdown, no backticks:
{
  "subject": "email subject line - specific and personal, not generic",
  "body": "the full email body with \\n for line breaks",
  "follow_up": "a short 2 sentence follow up to send 3 days later if no reply"
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      email_subject: parsed.subject,
      email_body: parsed.body,
      follow_up_body: parsed.follow_up,
    };
  } catch (err) {
    console.error(`Email writing failed for ${lead.business_name}:`, err.message);
    return {
      email_subject: `${client.trade} available in ${client.location}`,
      email_body: `Hi,\n\nI'm a ${client.trade} based in ${client.location} and I'm looking to take on new work in the area.\n\nWould you be open to a quick chat?\n\nThanks`,
      follow_up_body: `Hi, just following up on my previous email. Happy to chat if you have 5 minutes.`,
    };
  }
};

// Score how well a lead fits the client
export const scoreLead = async (client, lead) => {
  // Simple scoring without using Claude to save costs
  let score = 50; // base score
  const reasons = [];

  // Location match
  const clientCity = client.location?.toLowerCase();
  const leadCity = lead.city?.toLowerCase();
  if (clientCity && leadCity && leadCity.includes(clientCity)) {
    score += 20;
    reasons.push('Same city');
  }

  // Business type match
  const idealClients = client.ideal_clients?.map(c => c.toLowerCase()) || [];
  const leadType = lead.business_type?.toLowerCase() || '';
  const typeMatch = idealClients.some(ic => 
    ic.includes(leadType) || leadType.includes(ic.split(' ')[0])
  );
  if (typeMatch) {
    score += 20;
    reasons.push('Matches target client type');
  }

  // Has website (more established)
  if (lead.website) {
    score += 5;
    reasons.push('Has website');
  }

  // Has contact name
  if (lead.contact_name) {
    score += 5;
    reasons.push('Has named contact');
  }

  return {
    fit_score: Math.min(score, 100),
    fit_reason: reasons.join(', ') || 'General match',
  };
};
