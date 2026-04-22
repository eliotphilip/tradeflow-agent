// src/sources/_shared.js
// Shared utilities used by all source modules
// Normalisation, deduplication, distance calculations

/**
 * @typedef {Object} NormalisedLead
 * @property {string} source
 * @property {string} source_id
 * @property {string|null} container_type
 * @property {string|null} buyer_archetype
 * @property {string} business_name
 * @property {string|null} address
 * @property {string|null} city
 * @property {string|null} postcode
 * @property {string|null} website
 * @property {string|null} phone
 * @property {string|null} email
 * @property {string} description
 * @property {Object} source_metadata
 */

/**
 * Normalise a UK postcode for comparison
 */
export function normalisePostcode(postcode) {
  if (!postcode) return null;
  const cleaned = postcode.toUpperCase().replace(/\s+/g, '');
  if (cleaned.length < 5) return cleaned;
  return `${cleaned.slice(0, -3)} ${cleaned.slice(-3)}`;
}

/**
 * Normalise a business name for deduplication
 */
export function normaliseBusinessName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|llp|cic|cio|uk|the)\b/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a dedupe key — same business from different sources should produce the same key
 */
export function dedupeKey(lead) {
  const name = normaliseBusinessName(lead.business_name);
  const postcode = normalisePostcode(lead.postcode);
  const postcodeArea = postcode ? postcode.split(' ')[0] : (lead.city || '').toLowerCase().slice(0, 5);
  return `${name}::${postcodeArea}`;
}

/**
 * Merge two leads for the same business from different sources
 * Prefer non-null values, keep first source identity
 */
export function mergeLeads(a, b) {
  return {
    ...a,
    website: a.website ?? b.website,
    phone: a.phone ?? b.phone,
    email: a.email ?? b.email,
    address: a.address ?? b.address,
    city: a.city ?? b.city,
    postcode: a.postcode ?? b.postcode,
    description: [a.description, b.description].filter(Boolean).join(' | '),
    source_metadata: {
      ...a.source_metadata,
      [`merged_from_${b.source}`]: b.source_metadata,
    },
  };
}

/**
 * Haversine distance in miles between two lat/lng points
 */
export function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Simple sleep helper
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
