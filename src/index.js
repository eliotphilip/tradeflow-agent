// src/index.js
// Main orchestrator - runs the full lead generation pipeline
// Called by GitHub Actions on a schedule or manually

import { createClient } from '@supabase/supabase-js';
import { findLeadsFromCompaniesHouse } from './sources/companiesHouse.js';
import { findLeadsFromGoogleMaps } from './sources/googleMaps.js';
import { findLeadsFromYell } from './sources/yell.js';
import { writeEmail, scoreLead } from './emailWriter.js';
import { calculateDistance } from './utils/distance.js';

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

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .insert({ client_id: client.id, status: 'running' })
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

    const [chLeads, gmLeads, yellLeads] = await Promise.allSettled([
      findLeadsFromCompaniesHouse(client),
      findLeadsFromGoogleMaps(client, GOOGLE_MAPS_API_KEY),
      findLeadsFromYell(client),
    ]);

    const allLeads = [
      ...(chLeads.status === 'fulfilled' ? chLeads.value : []),
      ...(gmLeads.status === 'fulfilled' ? gmLeads.value : []),
      ...(yellLeads.status === 'fulfilled' ? yellLeads.value : []),
    ];

    console.log(`\n📊 Total leads found: ${allLeads.length}`);
    console.log(`   CH: ${chLeads.status === 'fulfilled' ? chLeads.value.length : 0} | Maps: ${gmLeads.status === 'fulfilled' ? gmLeads.value.length : 0} | Yell: ${yellLeads.status === 'fulfilled' ? yellLeads.value.length : 0}`);

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
    // STEP 3: Filter out existing leads
    // ----------------------------------------
    console.log('\n🔍 Checking for existing leads...');

    const { data: existingLeads } = await supabase
      .from('leads')
      .select('business_name, city')
      .eq('client_id', client.id);

    const existingKeys = new Set(
      (existingLeads || []).map(l =>
        `${l.business_name?.toLowerCase()}-${l.city?.toLowerCase()}`
      )
    );

    const newLeads = uniqueLeads.filter(lead => {
      const key = `${lead.business_name?.toLowerCase()}-${lead.city?.toLowerCase()}`;
      return !existingKeys.has(key);
    });

    console.log(`📊 ${uniqueLeads.length} found — ${existingKeys.size} already in DB — ${newLeads.length} new`);

    if (newLeads.length === 0) {
      console.log('✅ No new leads to process');
      await supabase.from('campaigns').update({
        status: 'complete',
        leads_found: allLeads.length,
        leads_qualified: 0,
        emails_drafted: 0,
        completed_at: new Date().toISOString(),
      }).eq('id', campaign.id);
      return;
    }

    // ----------------------------------------
    // STEP 4: Load feedback data
    // ----------------------------------------
    console.log('\n📚 Loading feedback data...');

    const { data: approvedLeads } = await supabase
      .from('leads')
      .select('business_name, business_type, city')
      .eq('client_id', client.id)
      .eq('status', 'approved')
      .limit(10);

    const { data: archivedLeads } = await supabase
      .from('leads')
      .select('business_name, business_type, city')
      .eq('client_id', client.id)
      .eq('status', 'archived')
      .limit(10);

    console.log(`   ✅ ${approvedLeads?.length || 0} approved, ${archivedLeads?.length || 0} archived for calibration`);

    // ----------------------------------------
    // STEP 5: Score and filter leads
    // ----------------------------------------
    console.log('\n🎯 Step 3: Scoring leads...');
    const scoredLeads = [];

    for (const lead of newLeads) {
      const score = await scoreLead(client, lead, approvedLeads || [], archivedLeads || []);
      scoredLeads.push({ ...lead, ...score });
    }

    const qualifiedLeads = scoredLeads
      .filter(l => l.fit_score >= 50)
      .sort((a, b) => {
        if (b.matches_perfect_lead_def && !a.matches_perfect_lead_def) return 1;
        if (a.matches_perfect_lead_def && !b.matches_perfect_lead_def) return -1;
        return b.fit_score - a.fit_score;
      })
      .slice(0, 60);

    const perfectMatches = qualifiedLeads.filter(l => l.matches_perfect_lead_def).length;
    console.log(`✅ Qualified leads: ${qualifiedLeads.length} (${perfectMatches} perfect matches ⭐)`);

    // ----------------------------------------
    // STEP 6: Calculate distances (location-based businesses only)
    // ----------------------------------------
    const isLocationBased = client.location_radius && client.location_radius < 100;
    let leadsWithDistances = [];

    if (isLocationBased) {
      console.log(`\n📏 Step 4: Calculating distances (radius: ${client.location_radius} miles)...`);

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
        await sleep(150);
      }

      const withDistance = leadsWithDistances.filter(l => l.distance_miles !== null);
      console.log(`✅ Distance calculated for ${withDistance.length}/${leadsWithDistances.length} leads`);

    } else {
      console.log('\n📏 Step 4: Skipping distances — nationwide or no radius set');
      leadsWithDistances = qualifiedLeads.map(l => ({ ...l, distance_miles: null }));
    }

    // ----------------------------------------
    // STEP 7: Write emails
    // ----------------------------------------
    console.log('\n✍️  Step 5: Writing personalised emails...');
    const leadsWithEmails = [];

    for (const lead of leadsWithDistances) {
      const emailContent = await writeEmail(client, lead);
      leadsWithEmails.push({ ...lead, ...emailContent });
      await sleep(300);
    }

    // ----------------------------------------
    // STEP 8: Save to Supabase
    // ----------------------------------------
    console.log('\n💾 Step 6: Saving leads to database...');

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
        matches_perfect_lead_def: lead.matches_perfect_lead_def || false,
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
    // STEP 9: Update records
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
    console.log(`   Perfect matches: ${perfectMatches} ⭐`);
    console.log(`   Emails drafted: ${leadsWithEmails.length}`);
    console.log(`   Saved: ${savedCount}`);

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
    console.error('❌ Missing Supabase credentials'); process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ Missing Anthropic API key'); process.exit(1);
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('❌ Missing Google Maps API key'); process.exit(1);
  }

  const clientId = process.env.CLIENT_ID?.trim();
  let clients = [];

  if (clientId) {
    console.log(`\n🎯 Manual trigger — running for single client: ${clientId}`);
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .eq('onboarding_complete', true)
      .limit(1);

    if (error) { console.error('❌ Failed to fetch client:', error.message); process.exit(1); }
    if (!data || data.length === 0) { console.error('❌ Client not found'); process.exit(1); }
    clients = data;

  } else {
    console.log(`\n📅 Scheduled run — processing all active clients`);
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('onboarding_complete', true)
      .eq('campaign_active', true);

    if (error) { console.error('❌ Failed to fetch clients:', error.message); process.exit(1); }
    clients = data || [];
  }

  if (clients.length === 0) { console.log('ℹ️  No clients to process.'); process.exit(0); }

  console.log(`\n👥 Processing ${clients.length} client(s)`);

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
