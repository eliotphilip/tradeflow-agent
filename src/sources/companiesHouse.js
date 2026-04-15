// src/sources/companiesHouse.js
// Finds small UK businesses using the free Companies House API
// No API key needed - completely free

const CH_BASE_URL = 'https://api.company-information.service.gov.uk';

// SIC codes relevant to our target industries
// These are the industries that hire tradespeople
const TARGET_SIC_CODES = {
  'property_developer': ['68100', '68201', '68209', '41100', '41201', '41202'],
  'architect':          ['71111', '71112'],
  'construction':       ['41100', '41201', '41202', '43210', '43220', '43290', '43310', '43320', '43330', '43341', '43342', '43390', '43910', '43999'],
  'letting_agent':      ['68310', '68320'],
  'facilities':         ['81100', '81210', '81220', '81290'],
  'interior_design':    ['74100'],
};

// Map client's ideal client selections to SIC codes
const mapClientTypesToSIC = (idealClients) => {
  const sics = new Set();
  idealClients.forEach(clientType => {
    const type = clientType.toLowerCase();
    if (type.includes('developer')) TARGET_SIC_CODES.property_developer.forEach(s => sics.add(s));
    if (type.includes('architect'))  TARGET_SIC_CODES.architect.forEach(s => sics.add(s));
    if (type.includes('contractor') || type.includes('construction')) TARGET_SIC_CODES.construction.forEach(s => sics.add(s));
    if (type.includes('letting') || type.includes('agent')) TARGET_SIC_CODES.letting_agent.forEach(s => sics.add(s));
    if (type.includes('facilities')) TARGET_SIC_CODES.facilities.forEach(s => sics.add(s));
    if (type.includes('interior'))   TARGET_SIC_CODES.interior_design.forEach(s => sics.add(s));
  });
  // Default fallback
  if (sics.size === 0) {
    TARGET_SIC_CODES.property_developer.forEach(s => sics.add(s));
    TARGET_SIC_CODES.construction.forEach(s => sics.add(s));
  }
  return Array.from(sics);
};

// Search Companies House for businesses
const searchCompanies = async (query, location) => {
  try {
    const url = `${CH_BASE_URL}/search/companies?q=${encodeURIComponent(query + ' ' + location)}&items_per_page=20`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        // Companies House public search doesn't need auth
      }
    });

    if (!response.ok) {
      console.log(`Companies House search failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.items || [];
  } catch (err) {
    console.error('Companies House search error:', err.message);
    return [];
  }
};

// Get detailed company info
const getCompanyDetails = async (companyNumber) => {
  try {
    const response = await fetch(`${CH_BASE_URL}/company/${companyNumber}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    return null;
  }
};

// Get company officers (directors) - so we know who to email
const getCompanyOfficers = async (companyNumber) => {
  try {
    const response = await fetch(`${CH_BASE_URL}/company/${companyNumber}/officers`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.items || [];
  } catch (err) {
    return [];
  }
};

// Main function - finds leads from Companies House
export const findLeadsFromCompaniesHouse = async (client) => {
  console.log(`🏛️  Searching Companies House for leads in ${client.location}...`);
  
  const leads = [];
  const idealClients = client.ideal_clients || ['Property developers', 'Architects'];
  
  // Build search queries based on client's targets
  const searchQueries = [];
  idealClients.forEach(type => {
    const t = type.toLowerCase();
    if (t.includes('developer'))  searchQueries.push('property developer');
    if (t.includes('architect'))  searchQueries.push('architect');
    if (t.includes('contractor')) searchQueries.push('building contractor');
    if (t.includes('letting'))    searchQueries.push('letting agent');
    if (t.includes('facilities')) searchQueries.push('facilities management');
    if (t.includes('interior'))   searchQueries.push('interior design');
    if (t.includes('landlord'))   searchQueries.push('property management');
    if (t.includes('hotel'))      searchQueries.push('hotel');
    if (t.includes('office') || t.includes('commercial')) searchQueries.push('commercial property');
  });

  // Run searches
  const seenNumbers = new Set();
  
  for (const query of searchQueries.slice(0, 4)) { // limit to 4 queries
    const results = await searchCompanies(query, client.location);
    
    for (const company of results) {
      if (seenNumbers.has(company.company_number)) continue;
      seenNumbers.add(company.company_number);

      // Only active companies
      if (company.company_status !== 'active') continue;

      // Get directors
      const officers = await getCompanyOfficers(company.company_number);
      const directors = officers.filter(o => 
        o.officer_role === 'director' && !o.resigned_on
      );
      
      const contactName = directors.length > 0 
        ? formatName(directors[0].name)
        : null;

      // Build lead object
      const lead = {
        business_name: company.title,
        contact_name: contactName,
        address: formatAddress(company.registered_office_address),
        city: extractCity(company.registered_office_address, client.location),
        postcode: company.registered_office_address?.postal_code,
        business_type: query,
        source: 'companies_house',
        source_id: company.company_number,
        description: `Registered ${company.company_type} company. SIC: ${company.sic_codes?.join(', ') || 'unknown'}. Incorporated ${company.date_of_creation || 'unknown'}.`,
      };

      leads.push(lead);
    }

    // Small delay to be respectful to the API
    await sleep(500);
  }

  console.log(`✅ Companies House found ${leads.length} potential leads`);
  return leads;
};

// Helper functions
const formatName = (name) => {
  if (!name) return null;
  // Companies House returns "SURNAME, Firstname"
  const parts = name.split(', ');
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`;
  return name;
};

const formatAddress = (addr) => {
  if (!addr) return null;
  return [addr.address_line_1, addr.address_line_2, addr.locality, addr.postal_code]
    .filter(Boolean).join(', ');
};

const extractCity = (addr, fallback) => {
  return addr?.locality || addr?.region || fallback;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
