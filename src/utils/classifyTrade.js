// src/utils/classifyTrade.js
// Classifies a trade as local_only, remote_capable, or hybrid
// Used to determine whether nationwide search is appropriate
// Called during campaign to set search strategy

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cache classifications in memory for the session — no need to re-ask for the same trade
const classificationCache = new Map();

export const classifyTrade = async (trade) => {
  if (!trade) return 'local_only';

  const normalised = trade.toLowerCase().trim();

  // Check memory cache first
  if (classificationCache.has(normalised)) {
    return classificationCache.get(normalised);
  }

  try {
    const prompt = `You are classifying a business trade or profession to determine whether it requires physical presence at a client location.

Trade: "${trade}"

Classification options:
- local_only: The work MUST be done in person at a physical location. Cannot be done remotely. Examples: plumber, joiner, electrician, builder, plasterer, roofer, landscaper, cleaner, mobile hairdresser, mechanic, glazier, tiler, carpet fitter, removal company, pest control
- remote_capable: The work CAN be done entirely remotely with no need to visit a client. Examples: web designer, accountant, copywriter, software developer, graphic designer, marketing consultant, SEO specialist, bookkeeper, financial advisor, PR consultant
- hybrid: The work is sometimes local and sometimes remote depending on the job. Examples: photographer, videographer, personal trainer, business coach, architect, surveyor, event planner, translator, tutor

Return ONLY one of these three values, nothing else: local_only, remote_capable, or hybrid`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = response.content[0].text.trim().toLowerCase();

    // Validate response
    const valid = ['local_only', 'remote_capable', 'hybrid'];
    const classification = valid.includes(result) ? result : 'local_only';

    // Cache it
    classificationCache.set(normalised, classification);

    console.log(`   🔍 Trade classification: "${trade}" → ${classification}`);
    return classification;

  } catch (err) {
    console.error('Trade classification failed:', err.message);
    // Default to local_only if classification fails — safer assumption
    return 'local_only';
  }
};

// Get the recommended max radius for a trade
export const getMaxRadius = (classification) => {
  switch (classification) {
    case 'local_only': return 75;
    case 'hybrid': return 150;
    case 'remote_capable': return null; // no limit
    default: return 75;
  }
};

// Determine if nationwide search should be used
export const isNationwide = (client, classification) => {
  // If client explicitly set no radius, treat as nationwide
  if (!client.location_radius) return true;

  // Local trades are never nationwide regardless of setting
  if (classification === 'local_only') return false;

  // Remote capable with high radius = nationwide
  if (classification === 'remote_capable' && client.location_radius >= 100) return true;

  // Hybrid with very high radius = nationwide
  if (classification === 'hybrid' && client.location_radius >= 150) return true;

  return false;
};
