// src/sources/cqc.js
// Finds care homes, hospices and care services using CQC Syndication API
// Free API — register at api-portal.service.cqc.org.uk

import { normalisePostcode, haversineMiles, sleep } from './_shared.js';

const CQC_BASE = 'https://api.service.cqc.org.uk/public/v1';
const CQC_KEY = process.env.CQC_API_KEY;
const USER_AGENT = 'TradeFlow/1.0';

const REQUEST_DELAY_MS = 200;
const MAX_PAGES = 20;
const PAGE_SIZE = 500;

async function cqcFetch(path, params = {}) {
  const url = new URL(`${CQC_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      v.forEach((val) => url.searchParams.append(k, val));
    } else if (v !== undefined && v !== null) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url, {
    headers: {
      'Ocp-Apim-Subscription-Key': CQC_KEY,
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    },
  });

  if (res.status === 429) {
    await sleep(3000);
    return cqcFetch(path, params);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CQC ${res.status} on ${url.pathname}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

async function listLocationIds({ postcode, limit }) {
  const ids = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await cqcFetch('/locations', {
      page,
      perPage: PAGE_SIZE,
      postCode: postcode ?? undefined,
    });

    const locations = data?.locations ?? [];
    if (!locations.length) break;

    for (const loc of locations) {
      ids.push(loc.locationId);
      if (ids.length >= limit) return ids;
    }

    if (locations.length < PAGE_SIZE) break;
    await sleep(REQUEST_DELAY_MS);
  }
  return ids;
}

async function getLocation(locationId) {
  return cqcFetch(`/locations/${locationId}`);
}

function matchesServiceTypes(location, wantedTypes) {
  if (!wantedTypes || !wantedTypes.length) return true;
  const actual = (location.gacServiceTypes ?? []).map((t) => t.name?.toLowerCase?.() ?? '');
  return wantedTypes.some((wanted) =>
    actual.some((a) => a.includes(wanted.toLowerCase()))
  );
}

function passesCapacityFilter(location, minCapacity) {
  if (!minCapacity) return true;
  return (location.numberOfBeds ?? 0) >= minCapacity;
}

function passesRatingFilter(location, allowedRatings) {
  if (!allowedRatings || !allowedRatings.length) return true;
  const overall = location?.currentRatings?.overall?.rating ?? null;
  if (!overall) return false;
  return allowedRatings.includes(overall);
}

function withinRadius(location, base, radiusMiles) {
  if (!base || !radiusMiles) return true;
  const lat = location?.onspdLatitude;
  const lon = location?.onspdLongitude;
  if (lat == null || lon == null) return true;
  return haversineMiles(base.lat, base.lon, lat, lon) <= radiusMiles;
}

function toNormalisedLead(location) {
  const address = [
    location.postalAddressLine1,
    location.postalAddressLine2,
    location.postalAddressTownCity,
  ].filter(Boolean).join(', ');

  const rating = location?.currentRatings?.overall?.rating ?? 'Unknown';
  const serviceTypes = (location.gacServiceTypes ?? []).map((t) => t.name).join(', ');
  const beds = location.numberOfBeds ?? null;

  return {
    source: 'cqc',
    source_id: location.locationId,
    container_type: null,
    buyer_archetype: null,
    business_name: location.name,
    address: address || null,
    city: location.postalAddressTownCity ?? null,
    postcode: normalisePostcode(location.postalCode),
    website: location.website ?? null,
    phone: location.mainPhoneNumber ?? null,
    email: null,
    description: `CQC registered ${serviceTypes || 'care service'}. Rating: ${rating}.${beds ? ` ${beds} beds.` : ''} Provider: ${location.providerName ?? 'unknown'}.`,
    source_metadata: {
      provider_id: location.providerId,
      provider_name: location.providerName,
      overall_rating: rating,
      number_of_beds: beds,
      service_types: location.gacServiceTypes ?? [],
      specialisms: location.specialisms ?? [],
      registration_date: location.registrationDate,
      last_inspection: location?.lastInspection?.date ?? null,
      ons_lat: location.onspdLatitude ?? null,
      ons_lon: location.onspdLongitude ?? null,
    },
  };
}

/**
 * Fetch leads from CQC
 * @param {Object} args
 * @param {Object} args.container - Container config from container_types.json
 * @param {Object} args.client - Client record from Supabase
 * @param {number} [args.limit=100]
 * @returns {Promise<NormalisedLead[]>}
 */
export async function fetchLeads({ container, client, limit = 100 }) {
  if (!CQC_KEY) {
    console.log('⚠️  No CQC_API_KEY — skipping CQC search');
    return [];
  }

  console.log(`🏥 Searching CQC for ${container.display_name}...`);

  const cqcFilters = container.cqc_filters ?? {};
  const wantedServiceTypes = cqcFilters.service_types ?? [];
  const allowedRatings = cqcFilters.allowed_ratings ?? null;
  const minCapacity = cqcFilters.min_capacity ?? null;

  // Use client's base postcode area for geographic search
  const postcodeSearch = client?.trade_profile?.base_postcode_area ?? null;

  // Over-fetch then filter client-side
  const idLimit = Math.min(limit * 3, 1500);

  const ids = await listLocationIds({
    postcode: postcodeSearch,
    limit: idLimit,
  });

  const leads = [];
  const base = client?.trade_profile?.base_lat && client?.trade_profile?.base_lon
    ? { lat: client.trade_profile.base_lat, lon: client.trade_profile.base_lon }
    : null;
  const radius = client?.location_radius ?? null;

  for (const id of ids) {
    if (leads.length >= limit) break;

    try {
      const location = await getLocation(id);

      if (!matchesServiceTypes(location, wantedServiceTypes)) continue;
      if (!passesCapacityFilter(location, minCapacity)) continue;
      if (!passesRatingFilter(location, allowedRatings)) continue;
      if (!withinRadius(location, base, radius)) continue;
      if (location?.registrationStatus !== 'Registered') continue;

      leads.push(toNormalisedLead(location));
    } catch (err) {
      console.warn(`[cqc] skipping ${id}: ${err.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`✅ CQC found ${leads.length} ${container.display_name} leads`);
  return leads;
}
