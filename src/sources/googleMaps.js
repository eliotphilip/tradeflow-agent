// src/sources/googleMaps.js
// Finds leads using Google Maps Places API
// Adapts search strategy based on trade classification and location radius

import Anthropic from '@anthropic-ai/sdk';

const MAPS_BASE_URL = 'https://maps.googleapis.com/maps/api';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Ask Claude what to search for based on client profile and search mode
const generateSearchQueries = async (client, nationwide) => {
  try {
    const locationContext = nationwide
      ? `They work nationwide across the UK — do not include any specific city in the queries.`
      : `They are based in ${client.location} and work within ${client.location_radius || 20} miles.`;

    const prompt = `A ${client.trade} business wants to find potential clients using Google Maps searches.
${locationContext}
Their ideal clients are: ${client.ideal_clients?.join(', ') || 'local businesses'}.
They want work in: ${client.work_types?.join(', ') || 'general work'}.

Generate 5 Google Maps search queries to find their ideal clients.
Think carefully about what types of businesses would realistically hire a ${client.trade}.
${nationwide ? 'Since this is nationwide, focus on business TYPE only — no city names.' : 'Keep queries short and do NOT include the city name — we add that separately.'}

Return ONLY a JSON array of short strings (2-4 words each), no markdown, no city names:
Example for joiner: ["property developer", "architect", "building contractor", "letting agent", "housing association"]
Example for web designer: ["ecommerce business", "marketing agency", "retail brand", "startup company", "hospitality group"]`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    const queries = JSON.parse(text);
    console.log(`   🧠 Claude generated Maps queries: ${queries.join(', ')}`);
    return queries;
  } catch (err) {
    console.log('   ⚠️  Maps query generation failed, using fallback');
    return ['local business', 'company', 'office', 'commercial property', 'business centre'];
  }
};

// Search Google Maps Places API
const searchPlaces = async (query, location, apiKey, nationwide) => {
  try {
    // For nationwide searches, don't restrict to a specific location
    const searchTerm = nationwide
      ? `${query} UK`
      : `${query} near ${location}`;

    const url = `${MAPS_BASE_URL}/place/textsearch/json?query=${encodeURIComponent(searchTerm)}&key=${apiKey}`;

    const response = await fetch(url);
    if (!response.ok) return [];

    const data = await response.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.log(`   Google Maps API status: ${data.status}`);
      return [];
    }

    return data.results || [];
  } catch (err) {
    console.error('Google Maps search error:', err.message);
    return [];
  }
};

// Get detailed place info
const getPlaceDetails = async (placeId, apiKey) => {
  try {
    const fields = 'name,formatted_address,formatted_phone_number,website,business_status';
    const url = `${MAPS_BASE_URL}/place/details/json?place_id=${placeId}&fields=${fields}&key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.result || null;
  } catch (err) {
    return null;
  }
};

// Main function
export const findLeadsFromGoogleMaps = async (client, apiKey, nationwide = false) => {
  if (nationwide) {
    console.log(`🗺️  Searching Google Maps nationwide for ${client.trade} leads...`);
  } else {
    console.log(`🗺️  Searching Google Maps for leads in ${client.location}...`);
  }

  const queries = await generateSearchQueries(client, nationwide);
  const leads = [];
  const seenPlaceIds = new Set();

  for (const query of queries) {
    const searchLabel = nationwide ? `${query} UK` : `${query} near ${client.location}`;
    console.log(`   Searching Maps: "${searchLabel}"`);

    const results = await searchPlaces(query, client.location, apiKey, nationwide);

    for (const place of results.slice(0, 10)) {
      if (seenPlaceIds.has(place.place_id)) continue;
      seenPlaceIds.add(place.place_id);
      if (place.business_status && place.business_status !== 'OPERATIONAL') continue;

      const details = await getPlaceDetails(place.place_id, apiKey);
      await sleep(200);

      const lead = {
        business_name: place.name,
        address: place.formatted_address,
        city: extractCity(place.formatted_address, client.location),
        phone: details?.formatted_phone_number || null,
        website: details?.website || null,
        business_type: query,
        source: 'google_maps',
        source_id: place.place_id,
        description: `Found via Google Maps. Category: ${query}. Rating: ${place.rating || 'N/A'} (${place.user_ratings_total || 0} reviews).`,
      };

      leads.push(lead);
    }

    await sleep(500);
  }

  console.log(`✅ Google Maps found ${leads.length} potential leads`);
  return leads;
};

const extractCity = (address, fallback) => {
  if (!address) return fallback;
  const parts = address.split(',');
  if (parts.length >= 3) return parts[parts.length - 3]?.trim() || fallback;
  return fallback;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
