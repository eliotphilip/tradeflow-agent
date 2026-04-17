// src/utils/distance.js
// Calculates distance between two locations using Google Maps Geocoding API

const GEOCODE_BASE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// Haversine formula — calculates distance between two lat/lng points in miles
const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
};

const toRad = (deg) => deg * (Math.PI / 180);

// Geocode an address to lat/lng
const geocodeAddress = async (address, apiKey) => {
  try {
    const url = `${GEOCODE_BASE_URL}?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.log(`Geocoding failed: ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (data.status === 'REQUEST_DENIED') {
      console.log(`Geocoding denied: ${data.error_message || 'API key may not have Geocoding API enabled'}`);
      return null;
    }

    if (data.status !== 'OK' || !data.results?.[0]) {
      return null;
    }

    const { lat, lng } = data.results[0].geometry.location;
    return { lat, lng };
  } catch (err) {
    console.error('Geocoding error:', err.message);
    return null;
  }
};

// Calculate distance in miles between client location and lead address
export const calculateDistance = async (clientLocation, leadAddress, apiKey) => {
  if (!apiKey) {
    console.log('No Google Maps API key for distance calculation');
    return null;
  }

  try {
    // Add UK to improve geocoding accuracy
    const clientQuery = clientLocation.includes('UK') ? clientLocation : `${clientLocation}, UK`;
    const leadQuery = leadAddress.includes('UK') ? leadAddress : `${leadAddress}, UK`;

    const [clientCoords, leadCoords] = await Promise.all([
      geocodeAddress(clientQuery, apiKey),
      geocodeAddress(leadQuery, apiKey),
    ]);

    if (!clientCoords || !leadCoords) return null;

    return haversineDistance(
      clientCoords.lat, clientCoords.lng,
      leadCoords.lat, leadCoords.lng
    );
  } catch (err) {
    console.error('Distance calculation error:', err.message);
    return null;
  }
};
