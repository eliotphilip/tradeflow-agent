// src/sources/googleMaps.js
// Finds businesses using Google Maps Places API
// Exposes fetchLeads({ container, client, limit }) for the router

import { sleep } from './_shared.js';

const MAPS_BASE_URL = 'https://maps.googleapis.com/maps/api';

const searchPlaces = async (query, location, apiKey, nationwide) => {
  try {
    const searchTerm = nationwide ? `${query} UK` : `${query} near ${location}`;
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

const extractCity = (address, fallback) => {
  if (!address) return fallback;
  const parts = address.split(',');
  if (parts.length >= 3) return parts[parts.length - 3]?.trim() || fallback;
  return fallback;
};

/**
 * Fetch leads from Google Maps
 */
export async function fetchLeads({ container, client, limit = 60 }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.log('⚠️  No Google Maps API key — skipping');
    return [];
  }

  const nationwide = !client.location_radius || client.location_radius >= 100;
  const queries = container.google_maps_queries ?? [container.display_name];
  const leads = [];
  const seenPlaceIds = new Set();

  for (const query of queries) {
    if (leads.length >= limit) break;

    const results = await searchPlaces(query, client.location, apiKey, nationwide);

    for (const place of results.slice(0, 10)) {
      if (leads.length >= limit) break;
      if (seenPlaceIds.has(place.place_id)) continue;
      seenPlaceIds.add(place.place_id);
      if (place.business_status && place.business_status !== 'OPERATIONAL') continue;

      const details = await getPlaceDetails(place.place_id, apiKey);
      await sleep(200);

      leads.push({
        source: 'google_maps',
        source_id: place.place_id,
        container_type: null,
        buyer_archetype: null,
        business_name: place.name,
        address: place.formatted_address,
        city: extractCity(place.formatted_address, client.location),
        postcode: null,
        website: details?.website || null,
        phone: details?.formatted_phone_number || null,
        email: null,
        description: `Found via Google Maps. Category: ${query}. Rating: ${place.rating || 'N/A'} (${place.user_ratings_total || 0} reviews).`,
        source_metadata: {
          place_id: place.place_id,
          rating: place.rating,
          user_ratings_total: place.user_ratings_total,
          types: place.types,
          query_used: query,
        },
      });
    }

    await sleep(500);
  }

  console.log(`✅ Google Maps found ${leads.length} ${container.display_name} leads`);
  return leads;
}
