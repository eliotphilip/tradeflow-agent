// src/sources/companiesHouse.js
// Finds UK registered businesses using Companies House API
// Exposes fetchLeads({ container, client, limit }) for the router

import Anthropic from '@anthropic-ai/sdk';
import { normalisePostcode, sleep } from './_shared.js';

const CH_BASE_URL = 'https://api.company-information.service.gov.uk';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const generateSearchQueries = async (container, client) => {
  try {
    const prompt = `A ${client.trade} business wants to find ${container.display_name} organisations on Companies House UK.
Location: ${client.location}

Generate 4 short Companies House keyword searches to find ${container.display_name} organisations.
Keep each to 2-3 words. Do NOT include city names.

Return ONLY a JSON array of strings, no markdown:
["search one", "search two", "search three", "search four"]`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    return [container.display_name];
  }
};

const searchCompanies = async (query, location, apiKey, nationwide) => {
  try {
    const searchTerm = nationwide ? query : `${query} ${location}`;
    const url = `${CH_BASE_URL}/search/companies?q=${encodeURIComponent(searchTerm)}&items_per_page=20`;
    const credentials = Buffer.from(`${apiKey}:`).toString('base64');
    const response = await fetch(url, {
      headers: { 'Authorization': `Basic ${credentials}`, 'Accept': 'application/json' }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.items || [];
  } catch (err) {
    return [];
  }
};

const getCompanyOfficers = async (companyNumber, apiKey) => {
  try {
    const credentials = Buffer.from(`${apiKey}:`).toString('base64');
    const response = await fetch(`${CH_BASE_URL}/company/${companyNumber}/officers`, {
      headers: { 'Authorization': `Basic ${credentials}`, 'Accept': 'application/json' }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.items || [];
  } catch (err) {
    return [];
  }
};

const formatName = (name) => {
  if (!name) return null;
  const parts = name.split(', ');
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
};

const formatAddress = (addr) => {
  if (!addr) return null;
  return [addr.address_line_1, addr.address_line_2, addr.locality, addr.postal_code]
    .filter(Boolean).join(', ');
};

/**
 * Fetch leads from Companies House
 */
export async function fetchLeads({ container, client, limit = 60 }) {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    console.log('⚠️  No Companies House API key — skipping');
    return [];
  }

  const nationwide = !client.location_radius || client.location_radius >= 100;
  const leads = [];
  const seenNumbers = new Set();

  // Search by SIC codes first
  const sicCodes = container.companies_house_sic ?? [];
  for (const sic of sicCodes.slice(0, 3)) {
    if (leads.length >= limit) break;
    const searchTerm = nationwide ? sic : `${sic} ${client.location}`;
    const url = `${CH_BASE_URL}/search/companies?q=${encodeURIComponent(searchTerm)}&items_per_page=20`;
    const credentials = Buffer.from(`${apiKey}:`).toString('base64');

    try {
      const response = await fetch(url, {
        headers: { 'Authorization': `Basic ${credentials}`, 'Accept': 'application/json' }
      });
      if (!response.ok) continue;
      const data = await response.json();
      const results = data.items || [];

      for (const company of results) {
        if (leads.length >= limit) break;
        if (seenNumbers.has(company.company_number)) continue;
        if (company.company_status !== 'active') continue;
        seenNumbers.add(company.company_number);

        const officers = await getCompanyOfficers(company.company_number, apiKey);
        const directors = officers.filter(o => o.officer_role === 'director' && !o.resigned_on);
        const contactName = directors.length > 0 ? formatName(directors[0].name) : null;

        leads.push({
          source: 'companies_house',
          source_id: company.company_number,
          container_type: null,
          buyer_archetype: null,
          business_name: company.title,
          contact_name: contactName,
          address: formatAddress(company.registered_office_address),
          city: company.registered_office_address?.locality || client.location,
          postcode: normalisePostcode(company.registered_office_address?.postal_code),
          website: null,
          phone: null,
          email: null,
          description: `UK registered company. SIC: ${company.sic_codes?.join(', ') || 'unknown'}. Incorporated: ${company.date_of_creation || 'unknown'}.`,
          source_metadata: {
            company_type: company.company_type,
            sic_codes: company.sic_codes,
            date_of_creation: company.date_of_creation,
          },
        });
      }
    } catch (err) {
      console.error(`CH SIC search error: ${err.message}`);
    }
    await sleep(300);
  }

  // Keyword searches if needed
  if (leads.length < limit) {
    const queries = await generateSearchQueries(container, client);
    for (const query of queries) {
      if (leads.length >= limit) break;
      const results = await searchCompanies(query, client.location, apiKey, nationwide);

      for (const company of results) {
        if (leads.length >= limit) break;
        if (seenNumbers.has(company.company_number)) continue;
        if (company.company_status !== 'active') continue;
        seenNumbers.add(company.company_number);

        const officers = await getCompanyOfficers(company.company_number, apiKey);
        const directors = officers.filter(o => o.officer_role === 'director' && !o.resigned_on);
        const contactName = directors.length > 0 ? formatName(directors[0].name) : null;

        leads.push({
          source: 'companies_house',
          source_id: company.company_number,
          container_type: null,
          buyer_archetype: null,
          business_name: company.title,
          contact_name: contactName,
          address: formatAddress(company.registered_office_address),
          city: company.registered_office_address?.locality || client.location,
          postcode: normalisePostcode(company.registered_office_address?.postal_code),
          website: null,
          phone: null,
          email: null,
          description: `UK registered company. Type: ${company.company_type}. SIC: ${company.sic_codes?.join(', ') || 'unknown'}.`,
          source_metadata: {
            company_type: company.company_type,
            sic_codes: company.sic_codes,
          },
        });
      }
      await sleep(300);
    }
  }

  console.log(`✅ Companies House found ${leads.length} ${container.display_name} leads`);
  return leads;
}
