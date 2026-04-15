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
- Write like a real tradesperson firing off a quick email between jobs — not a salesperson
- Dry, understated tone. British. Matter of fact. No enthusiasm.
- NEVER say things like "your work looks solid", "speaks for itself", "keen to chat", "would love to", "happy to help"
- NO compliments about their business — it sounds fake
- NO exclamation marks. Ever.
- Keep it to 3 short paragraphs. Each paragraph max 2 sentences.
- Para 1: Who you are and what you do. One sentence.
- Para 2: One specific thing about their business that suggests they might need joinery work. No flattery.
- Para 3: Direct ask — are they looking for a joiner, and if so you're available.
- Sign off: just a name, no "Cheers", no "Best", no "Thanks" — just the name
- Use [First Name] if no contact name available
- Subject line: plain and direct, like "Joinery — [their city]" or "Available joiner — [trade type]"
- It should read like a text message, not a cover letter

EXAMPLE OF GOOD TONE:
"I'm a joiner based in Manchester, mainly working on residential refurbs and commercial fit-outs.

Noticed you do a fair amount of property development in the area — figured it was worth reaching out in case you ever need reliable joinery on a project.

Currently have availability. Let me know if it's worth a conversation."

Return ONLY a JSON object, no markdown, no backticks:
{
  "subject": "email subject line - plain and direct",
  "body": "the full email body with \\n for line breaks",
  "follow_up": "one sentence follow up, equally dry and direct, 3 days later"
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
