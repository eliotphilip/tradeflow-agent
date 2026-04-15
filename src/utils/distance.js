// src/utils/distance.js
// Calculates distance between two locations using Google Maps Geocoding API

// Haversine formula — calculates distance between two lat/lng points in miles
export const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10; // rounded to 1 decimal place
};

const toRad = (deg) => deg * (Math.PI / 180);

// Geocode an address string to lat/lng using Google Maps API
export const geocodeAddress = async (address, apiKey) => {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    if (data.status !== 'OK' || !data.results[0]) return null;
    const { lat, lng } = data.results[0].geometry.location;
    return { lat, lng };
  } catch (err) {
    return null;
  }
};

// Calculate distance in miles between client location and a lead address
export const calculateDistance = async (clientLocation, leadAddress, apiKey) => {
  try {
    // Geocode both addresses
    const [clientCoords, leadCoords] = await Promise.all([
      geocodeAddress(clientLocation, apiKey),
      geocodeAddress(leadAddress, apiKey),
    ]);

    if (!clientCoords || !leadCoords) return null;

    return haversineDistance(
      clientCoords.lat, clientCoords.lng,
      leadCoords.lat, leadCoords.lng
    );
  } catch (err) {
    return null;
  }
};
