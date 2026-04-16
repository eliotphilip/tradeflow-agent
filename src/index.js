// src/index.js
// Main orchestrator - runs the full lead generation pipeline
// Called by GitHub Actions on a schedule or manually

import { createClient } from '@supabase/supabase-js';
import { findLeadsFromCompaniesHouse } from './sources/companiesHouse.js';
import { findLeadsFromGoogleMaps } from './sources/googleMaps.js';
import { writeEmail, scoreLead } from './emailWriter.js';
import { calculateDistance } from './utils/distance.js';

// Init Supabase with service role key (full access)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ============================================
// MAIN PIPELINE
// ============================================
const runCampaign = async (client) => {
  console.log(`\n🚀 Starting campaign for ${client.business_name || client.email}`);
  console.log(`   Trade: ${client.trade} | Location: ${client.location}`);

  // Create campaign record
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .insert({
      client_id: client.id,
      status: 'running',
    })
    .select()
    .single();

  if (campaignError) {
    console.error('Failed to create campaign:', campaignError.message);
    return;
  }

  try {
    // ----------------------------------------
    // STEP 1: Find leads from all sources
    // ----------------------------------------
    console.log('\n📍 Step 1: Finding leads...');

    const [chLeads, gmLeads] = await Promise.allSettled([
      findLeadsFromCompaniesHouse(client),
      findLeadsFromGoogleMaps(client, GOOGLE_MAPS_API_KEY),
    ]);

    const allLeads = [
      ...(chLeads.status === 'fulfilled' ? chLeads.value : []),
      ...(gmLeads.status === 'fulfilled' ? gmLeads.value : []),
    ];

    console.log(`\n📊 Total leads found: ${allLeads.length}`);

    // ----------------------------------------
    // STEP 2: Deduplicate
    // ----------------------------------------
    const seen = new Set();
    const uniqueLeads = allLeads.filter(lead => {
      const key = `${lead.business_name?.toLowerCase()}-${lead.city?.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`🔄 After deduplication: ${uniqueLeads.length} leads`);

    // ----------------------------------------
    // STEP 3: Score and filter leads
    // ----------------------------------------
    console.log('\n🎯 Step 2: Scoring leads...');
    const scoredLeads = [];

    for (const lead of uniqueLeads) {
      const score = await scoreLead(client, lead);
      scoredLeads.push({ ...lead, ...score });
    }

    // Only keep leads with score above 50
    const qualifiedLeads = scoredLeads
      .filter(l => l.fit_score >= 50)
      .sort((a, b) => b.fit_score - a.fit_score)
      .slice(0, 60); // max 60 leads per campaign

    console.log(`✅ Qualified leads: ${qualifiedLeads.length}`);

    // ----------------------------------------
    // STEP 4: Calculate distances
    // ----------------------------------------
    console.log('\n📏 Step 3: Calculating distances...');
    const leadsWithDistances = [];

    for (const lead of qualifiedLeads) {
      let distance = null;
      if (lead.address && client.location) {
        distance = await calculateDistance(
          client.location,
          lead.address,
          GOOGLE_MAPS_API_KEY
        );
      }
      leadsWithDistances.push({ ...lead, distance_miles: distance });
      await sleep(100);
    }

    const withDistance = leadsWithDistances.filter(l => l.distance_miles !== null);
    console.log(`✅ Distance calculated for ${withDistance.length}/${leadsWithDistances.length} leads`);

    // ----------------------------------------
    // STEP 5: Write emails for each lead
    // ----------------------------------------
    console.log('\n✍️  Step 4: Writing personalised emails...');
    const leadsWithEmails = [];

    for (const lead of leadsWithDistances) {
      const emailContent = await writeEmail(client, lead);
      leadsWithEmails.push({ ...lead, ...emailContent });
      await sleep(300);
    }

    // ----------------------------------------
    // STEP 6: Save to Supabase
    // ----------------------------------------
    console.log('\n💾 Step 5: Saving leads to database...');

    const batches = chunkArray(leadsWithEmails, 10);
    let savedCount = 0;

    for (const batch of batches) {
      const leadsToInsert = batch.map(lead => ({
        client_id: client.id,
        business_name: lead.business_name,
        contact_name: lead.contact_name || null,
        email: lead.email || null,
        phone: lead.phone || null,
        website: lead.website || null,
        address: lead.address || null,
        city: lead.city || null,
        business_type: lead.business_type || null,
        description: lead.description || null,
        source: lead.source,
        source_id: lead.source_id || null,
        fit_score: lead.fit_score,
        fit_reason: lead.fit_reason,
        distance_miles: lead.distance_miles || null,
        email_subject: lead.email_subject,
        email_body: lead.email_body,
        follow_up_body: lead.follow_up_body,
        status: 'new',
      }));

      const { error } = await supabase
        .from('leads')
        .upsert(leadsToInsert, {
          onConflict: 'client_id,business_name,city',
          ignoreDuplicates: true,
        });

      if (error) {
        console.error('Batch save error:', error.message);
      } else {
        savedCount += batch.length;
      }
    }

    console.log(`✅ Saved ${savedCount} leads to database`);

    // ----------------------------------------
    // STEP 7: Update campaign record
    // ----------------------------------------
    await supabase
      .from('campaigns')
      .update({
        status: 'complete',
        leads_found: allLeads.length,
        leads_qualified: qualifiedLeads.length,
        emails_drafted: leadsWithEmails.length,
        completed_at: new Date().toISOString(),
      })
      .eq('id', campaign.id);

    await supabase
      .from('clients')
      .update({ last_campaign_run: new Date().toISOString() })
      .eq('id', client.id);

    console.log(`\n🎉 Campaign complete!`);
    console.log(`   Found: ${allLeads.length} leads`);
    console.log(`   Qualified: ${qualifiedLeads.length} leads`);
    console.log(`   Emails drafted: ${leadsWithEmails.length}`);
    console.log(`   Saved to dashboard: ${savedCount}`);

  } catch (err) {
    console.error('Campaign failed:', err.message);

    await supabase
      .from('campaigns')
      .update({
        status: 'failed',
        error_message: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', campaign.id);
  }
};

// ============================================
// ENTRY POINT
// ============================================
const main = async () => {
  console.log('🔄 TradeFlow Agent Starting...');
  console.log(`   Time: ${new Date().toISOString()}`);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing Supabase credentials');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ Missing Anthropic API key');
    process.exit(1);
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('❌ Missing Google Maps API key');
    process.exit(1);
  }

  const { data: clients, error } = await supabase
    .from('clients')
    .select('*')
    .eq('onboarding_complete', true)
    .eq('campaign_active', true);

  if (error) {
    console.error('Failed to fetch clients:', error.message);
    process.exit(1);
  }

  if (!clients || clients.length === 0) {
    console.log('ℹ️  No active clients found.');
    process.exit(0);
  }

  console.log(`\n👥 Found ${clients.length} active client(s)`);

  for (const client of clients) {
    await runCampaign(client);
    await sleep(2000);
  }

  console.log('\n✅ All campaigns complete');
};

// ============================================
// HELPERS
// ============================================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
