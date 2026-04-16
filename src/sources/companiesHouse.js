// src/sources/companiesHouse.js
// Finds UK registered businesses using Companies House API
// Uses Claude to generate smart search queries for any business type

import Anthropic from '@anthropic-ai/sdk';

const CH_BASE_URL = 'https://api.company-information.service.gov.uk';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Ask Claude what to search for on Companies House based on client profile
const generateSearchQueries = async (client) => {
  try {
    const prompt = `A ${client.trade} business in ${client.location} wants to find potential clients on Companies House UK.
Their ideal clients are: ${client.ideal_clients?.join(', ') || 'local businesses'}.
They want work in: ${client.work_types?.join(', ') || 'general work'}.

Generate 4 short Companies House search queries that would find their ideal clients.
These are keyword searches used to find UK registered company names.
Keep each query to 2-3 words maximum.
Return ONLY a JSON array of strings, no markdown, no explanation.
Example: ["property developer", "letting agent", "building contractor", "facilities management"]`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    const queries = JSON.parse(text);
    console.log(`   🧠 Claude generated CH queries: ${queries.join(', ')}`);
    return queries;
  } catch (err) {
    console.log('   ⚠️  Claude query generation failed, using fallback');
    return ['property developer', 'building contractor', 'letting agent', 'facilities management'];
  }
};

// Search Companies House with authentication
const searchCompanies = async (query, location, apiKey) => {
  try {
    const searchTerm = `${query} ${location}`;
    const url = `${CH_BASE_URL}/search/companies?q=${encodeURIComponent(searchTerm)}&items_per_page=20`;

    // Companies House uses Basic auth with API key as username, empty password
    const credentials = Buffer.from(`${apiKey}:`).toString('base64');

    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      console.log(`   Companies House search failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.items || [];
  } catch (err) {
    console.error('Companies House search error:', err.message);
    return [];
  }
};

// Get company officers (directors)
const getCompanyOfficers = async (companyNumber, apiKey) => {
  try {
    const credentials = Buffer.from(`${apiKey}:`).toString('base64');
    const response = await fetch(`${CH_BASE_URL}/company/${companyNumber}/officers`, {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
      }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.items || [];
  } catch (err) {
    return [];
  }
};

// Main function
export const findLeadsFromCompaniesHouse = async (client) => {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    console.log('⚠️  No Companies House API key — skipping');
    return [];
  }

  console.log(`🏛️  Searching Companies House for leads in ${client.location}...`);

  // Ask Claude what to search for
  const searchQueries = await generateSearchQueries(client);

  const leads = [];
  const seenNumbers = new Set();

  for (const query of searchQueries) {
    console.log(`   Searching CH: "${query} ${client.location}"`);
    const results = await searchCompanies(query, client.location, apiKey);

    for (const company of results) {
      if (seenNumbers.has(company.company_number)) continue;
      seenNumbers.add(company.company_number);

      // Only active companies
      if (company.company_status !== 'active') continue;

      // Get directors
      const officers = await getCompanyOfficers(company.company_number, apiKey);
      const directors = officers.filter(o =>
        o.officer_role === 'director' && !o.resigned_on
      );

      const contactName = directors.length > 0
        ? formatName(directors[0].name)
        : null;

      const lead = {
        business_name: company.title,
        contact_name: contactName,
        address: formatAddress(company.registered_office_address),
        city: company.registered_office_address?.locality || client.location,
        postcode: company.registered_office_address?.postal_code,
        business_type: query,
        source: 'companies_house',
        source_id: company.company_number,
        description: `UK registered company. Type: ${company.company_type}. SIC: ${company.sic_codes?.join(', ') || 'unknown'}. Incorporated: ${company.date_of_creation || 'unknown'}.`,
      };

      leads.push(lead);
    }

    await sleep(300);
  }

  console.log(`✅ Companies House found ${leads.length} potential leads`);
  return leads;
};

const formatName = (name) => {
  if (!name) return null;
  const parts = name.split(', ');
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`;
  return name;
};

const formatAddress = (addr) => {
  if (!addr) return null;
  return [addr.address_line_1, addr.address_line_2, addr.locality, addr.postal_code]
    .filter(Boolean).join(', ');
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
