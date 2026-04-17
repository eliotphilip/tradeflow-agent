// src/sources/yell.js
// Scrapes Yell.com for local business leads
// Free — no API key needed
// Good for finding micro businesses and sole traders not in other databases

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Ask Claude what categories to search on Yell
const generateYellCategories = async (client) => {
  try {
    const prompt = `A ${client.trade} business in ${client.location} wants to find clients on Yell.com UK business directory.
Their ideal clients: ${client.ideal_clients?.join(', ') || 'local businesses'}.

Generate 3 Yell.com search categories to find their ideal clients.
These should be short category keywords that work as Yell search terms.
No city names — we add those separately.

Return ONLY a JSON array of strings, no markdown:
["category one", "category two", "category three"]`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    const categories = JSON.parse(text);
    console.log(`   🧠 Claude generated Yell categories: ${categories.join(', ')}`);
    return categories;
  } catch (err) {
    console.log('   ⚠️  Yell category generation failed, using fallback');
    return ['property developers', 'builders', 'architects'];
  }
};

// Scrape a single Yell search results page
const scrapeYellPage = async (category, location) => {
  try {
    const searchUrl = `https://www.yell.com/ucs/UcsSearchAction.do?keywords=${encodeURIComponent(category)}&location=${encodeURIComponent(location)}`;

    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.5',
      }
    });

    if (!response.ok) {
      console.log(`   Yell scrape failed: ${response.status}`);
      return [];
    }

    const html = await response.text();
    return parseYellResults(html, category, location);

  } catch (err) {
    console.error(`Yell scrape error for ${category}:`, err.message);
    return [];
  }
};

// Parse business listings from Yell HTML
const parseYellResults = (html, category, location) => {
  const leads = [];

  try {
    // Extract business listings using regex patterns
    // Yell listings follow consistent patterns in their HTML

    // Business name pattern
    const namePattern = /class="[^"]*businessCapsule--name[^"]*"[^>]*>([^<]+)</g;
    // Phone pattern
    const phonePattern = /class="[^"]*phonenumber[^"]*"[^>]*>([^<]+)</g;
    // Address pattern
    const addressPattern = /class="[^"]*businessCapsule--address[^"]*"[^>]*>([\s\S]*?)<\/address>/g;
    // Website pattern
    const websitePattern = /href="(https?:\/\/(?!www\.yell\.com)[^"]+)"[^>]*class="[^"]*website[^"]*"/g;

    const names = [];
    const phones = [];
    const addresses = [];
    const websites = [];

    let match;

    while ((match = namePattern.exec(html)) !== null) {
      const name = match[1].trim().replace(/\s+/g, ' ');
      if (name && name.length > 1) names.push(name);
    }

    while ((match = phonePattern.exec(html)) !== null) {
      phones.push(match[1].trim());
    }

    while ((match = addressPattern.exec(html)) !== null) {
      const addr = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (addr) addresses.push(addr);
    }

    while ((match = websitePattern.exec(html)) !== null) {
      websites.push(match[1]);
    }

    // Build lead objects from parsed data
    for (let i = 0; i < Math.min(names.length, 10); i++) {
      if (!names[i]) continue;

      leads.push({
        business_name: names[i],
        phone: phones[i] || null,
        address: addresses[i] || location,
        city: location,
        website: websites[i] || null,
        business_type: category,
        source: 'yell',
        source_id: `yell_${names[i].toLowerCase().replace(/\s+/g, '_')}`,
        description: `Found on Yell.com. Category: ${category}. Location: ${location}.`,
      });
    }

  } catch (err) {
    console.error('Yell parse error:', err.message);
  }

  return leads;
};

// Main function
export const findLeadsFromYell = async (client) => {
  console.log(`📒 Searching Yell.com for leads in ${client.location}...`);

  const categories = await generateYellCategories(client);
  const leads = [];
  const seenNames = new Set();

  for (const category of categories) {
    console.log(`   Searching Yell: "${category}" in ${client.location}`);
    const results = await scrapeYellPage(category, client.location);

    for (const lead of results) {
      if (seenNames.has(lead.business_name?.toLowerCase())) continue;
      seenNames.add(lead.business_name?.toLowerCase());
      leads.push(lead);
    }

    await sleep(1000); // Be respectful — 1 second between requests
  }

  console.log(`✅ Yell found ${leads.length} potential leads`);
  return leads;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
