// src/sources/googleMaps.js
// Finds local businesses using Google Maps Places API
// Free tier gives $200/month credit - more than enough

const MAPS_BASE_URL = 'https://maps.googleapis.com/maps/api';

// Map client's ideal clients to Google Maps search terms
const buildSearchQueries = (idealClients, workTypes) => {
  const queries = [];

  idealClients.forEach(type => {
    const t = type.toLowerCase();
    if (t.includes('developer'))  queries.push('property developer');
    if (t.includes('architect'))  queries.push('architect');
    if (t.includes('interior'))   queries.push('interior designer');
    if (t.includes('letting'))    queries.push('letting agent');
    if (t.includes('facilities')) queries.push('facilities management');
    if (t.includes('contractor')) queries.push('building contractor');
    if (t.includes('landlord'))   queries.push('property management company');
    if (t.includes('hotel'))      queries.push('hotel');
    if (t.includes('office') || t.includes('commercial')) queries.push('commercial property management');
  });

  // Add work-type based queries
  workTypes?.forEach(type => {
    const t = type.toLowerCase();
    if (t.includes('commercial')) queries.push('commercial fit out contractor');
    if (t.includes('new build'))  queries.push('new build developer');
  });

  // Remove duplicates
  return [...new Set(queries)].slice(0, 5);
};

// Search for places near a location
const searchPlaces = async (query, location, apiKey) => {
  try {
    const url = `${MAPS_BASE_URL}/place/textsearch/json?query=${encodeURIComponent(query + ' in ' + location)}&type=establishment&key=${apiKey}`;

    const response = await fetch(url);
    if (!response.ok) {
      console.log(`Google Maps search failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.log(`Google Maps API status: ${data.status}`);
      return [];
    }

    return data.results || [];
  } catch (err) {
    console.error('Google Maps search error:', err.message);
    return [];
  }
};

// Get detailed place info including website and phone
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

// Main function - finds leads from Google Maps
export const findLeadsFromGoogleMaps = async (client, apiKey) => {
  console.log(`🗺️  Searching Google Maps for leads in ${client.location}...`);

  const leads = [];
  const queries = buildSearchQueries(
    client.ideal_clients || ['Property developers'],
    client.work_types || []
  );

  const seenPlaceIds = new Set();

  for (const query of queries) {
    console.log(`   Searching: "${query} in ${client.location}"`);
    const results = await searchPlaces(query, client.location, apiKey);

    for (const place of results.slice(0, 10)) {
      if (seenPlaceIds.has(place.place_id)) continue;
      seenPlaceIds.add(place.place_id);

      // Only open/operational businesses
      if (place.business_status && place.business_status !== 'OPERATIONAL') continue;

      // Get full details including website
      const details = await getPlaceDetails(place.place_id, apiKey);
      await sleep(200); // be respectful to the API

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

// Extract city from formatted address
const extractCity = (address, fallback) => {
  if (!address) return fallback;
  const parts = address.split(',');
  // Typically "Street, City, Postcode, UK"
  if (parts.length >= 2) return parts[parts.length - 3]?.trim() || fallback;
  return fallback;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
