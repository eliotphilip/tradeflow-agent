// src/index.js
// Main orchestrator - runs the full lead generation pipeline
// Uses the container/router architecture for smart lead finding

import { createClient } from '@supabase/supabase-js';
import { EventEmitter } from 'events';
import { fetchLeadsForClient } from './sources/router.js';
import { scoreLead, writeEmail } from './emailWriter.js';
import { calculateDistance } from './utils/distance.js';
import { enrichLeadsBatch } from './enrichment/firecrawl.js';
import { enhanceClientProfile } from './utils/enhanceClient.js';

EventEmitter.defaultMaxListeners = 20;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const FIRECRAWL_ENABLED = !!process.env.FIRECRAWL_API_KEY;

const getScoringCap = (volumeVsPrecision) => {
  const caps = { 1: 80, 2: 60, 3: 50, 4: 35, 5: 20 };
  return caps[volumeVsPrecision] || 50;
};

// ============================================
// MAIN PIPELINE
// ============================================
const runCampaign = async (rawClient) => {
  console.log(`\n🚀 Starting campaign for ${rawClient.business_name || rawClient.email}`);
  console.log(`   Trade: ${rawClient.trade} | Location: ${rawClient.location}`);

  // STEP 0: Enhance client profile
  const client = await enhanceClientProfile(rawClient);

  // Determine search mode from location_radius
  const nationwide = !client.location_radius || client.location_radius >= 100;
  console.log(`   Mode: ${nationwide ? '🌍 nationwide' : `📍 local (${client.location_radius || 20} miles)`}`);

  if (!client.target_container_types?.length) {
    console.log('⚠️  No target_container_types set — client needs to complete onboarding');
  }

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
    // STEP 1: Find leads using the router
    console.log('\n📍 Step 1: Finding leads...');

    const { leads: allLeads, stats } = await fetchLeadsForClient({
      client,
      perContainerLimit: 40,
      concurrency: 3,
    });

    console.log(`\n📊 Total leads found: ${allLeads.length}`);
    if (stats.errors?.length > 0) {
      stats.errors.forEach(e => console.log(`   ⚠️  Error: ${e.source}/${e.container}: ${e.error}`));
    }

    // Log breakdown by source
    const gmCount = allLeads.filter(l => l.source === 'google_maps').length;
    const chCount = allLeads.filter(l => l.source === 'companies_house').length;
    const cqcCount = allLeads.filter(l => l.source === 'cqc').length;
    console.log(`   Google Maps: ${gmCount} | Companies House: ${chCount} | CQC: ${cqcCount}`);

    // STEP 2: Filter out existing leads
    console.log('\n🔍 Checking for existing leads...');

    const { data: existingLeads } = await supabase
      .from('leads')
      .select('source, source_id')
      .eq('client_id', client.id);

    const existingKeys = new Set(
      (existingLeads || []).map(l => `${l.source}::${l.source_id}`)
    );

    const newLeads = allLeads.filter(lead => {
      const key = `${lead.source}::${lead.source_id}`;
      return !existingKeys.has(key);
    });

    console.log(`📊 ${allLeads.length} found — ${existingKeys.size} already in DB — ${newLeads.length} new`);

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

    // STEP 3: Load feedback data
    console.log('\n📚 Loading feedback data...');
    const { data: approvedLeads } = await supabase
      .from('leads')
      .select('business_name, container_type, city')
      .eq('client_id', client.id)
      .eq('status', 'approved')
      .limit(10);

    const { data: archivedLeads } = await supabase
      .from('leads')
      .select('business_name, container_type, city')
      .eq('client_id', client.id)
      .eq('status', 'archived')
      .limit(10);

    console.log(`   ✅ ${approvedLeads?.length || 0} approved, ${archivedLeads?.length || 0} archived for calibration`);

    // STEP 4: Cap leads before scoring
    // Prioritise Google Maps leads — they have websites and are higher quality
    // CQC leads next — verified organisations
    // Companies House last — broadest but least filtered
    const scoringCap = getScoringCap(client.volume_vs_precision);
    const sortedNewLeads = [
      ...newLeads.filter(l => l.source === 'google_maps'),
      ...newLeads.filter(l => l.source === 'cqc'),
      ...newLeads.filter(l => l.source === 'companies_house'),
    ];
    const leadsToScore = sortedNewLeads.slice(0, scoringCap);
    console.log(`\n📊 Scoring cap: ${scoringCap} leads (${leadsToScore.filter(l => l.source === 'google_maps').length} Maps, ${leadsToScore.filter(l => l.source === 'cqc').length} CQC, ${leadsToScore.filter(l => l.source === 'companies_house').length} CH)`);

    // STEP 5: Initial scoring
    console.log('🎯 Scoring leads...');
    const scoredLeads = [];

    for (const lead of leadsToScore) {
      const score = await scoreLead(client, lead, approvedLeads || [], archivedLeads || []);
      scoredLeads.push({ ...lead, ...score });
    }

    // Debug — show sample scores
    const sampleScores = scoredLeads.slice(0, 5).map(l => `${l.business_name}: ${l.fit_score}`).join(' | ');
    console.log(`   Sample scores: ${sampleScores}`);

    const enrichmentCandidates = scoredLeads.filter(l => l.fit_score >= 30 && l.website);
    console.log(`   ${scoredLeads.filter(l => l.fit_score >= 30).length} above threshold, ${enrichmentCandidates.length} have websites`);

    // STEP 6: Firecrawl enrichment
    let enrichedLeads = scoredLeads;

    if (FIRECRAWL_ENABLED && enrichmentCandidates.length > 0) {
      console.log(`\n🌐 Enriching ${enrichmentCandidates.length} leads with Firecrawl...`);

      const enrichmentResults = await enrichLeadsBatch(enrichmentCandidates, { concurrency: 3 });
      let successCount = 0;
      let cacheHits = 0;

      enrichedLeads = scoredLeads.map(lead => {
        const enrichment = enrichmentResults.get(lead.business_name);
        if (!enrichment) return lead;

        if (enrichment.enrichment_status === 'success') {
          if (enrichment.from_cache) cacheHits++;
          else successCount++;

          return {
            ...lead,
            enrichment_data: enrichment.enrichment_data,
            enrichment_status: enrichment.enrichment_status,
            email: enrichment.enrichment_data?.contact?.email || lead.email,
          };
        }
        return { ...lead, enrichment_status: enrichment.enrichment_status };
      });

      console.log(`   ✅ ${successCount} new scrapes, ${cacheHits} from cache`);

      // Re-score enriched leads
      const reScored = [];
      for (const lead of enrichedLeads) {
        if (lead.enrichment_data) {
          const newScore = await scoreLead(client, lead, approvedLeads || [], archivedLeads || []);
          reScored.push({ ...lead, ...newScore });
        } else {
          reScored.push(lead);
        }
      }
      enrichedLeads = reScored;
    }

    // STEP 7: Filter and rank — threshold lowered to 30
    const qualifiedLeads = enrichedLeads
      .filter(l => l.fit_score >= 30)
      .sort((a, b) => {
        if (b.matches_perfect_lead_def && !a.matches_perfect_lead_def) return 1;
        if (a.matches_perfect_lead_def && !b.matches_perfect_lead_def) return -1;
        if (b.enrichment_data && !a.enrichment_data) return 1;
        if (a.enrichment_data && !b.enrichment_data) return -1;
        return b.fit_score - a.fit_score;
      })
      .slice(0, 40);

    const perfectMatches = qualifiedLeads.filter(l => l.matches_perfect_lead_def).length;
    const enrichedCount = qualifiedLeads.filter(l => l.enrichment_data).length;
    console.log(`\n✅ Qualified: ${qualifiedLeads.length} leads (${perfectMatches} perfect ⭐, ${enrichedCount} enriched 🌐)`);

    // STEP 8: Calculate distances (local only)
    const shouldCalculateDistance = !nationwide && client.location_radius;
    let leadsWithDistances = [];

    if (shouldCalculateDistance) {
      console.log(`\n📏 Calculating distances...`);
      for (const lead of qualifiedLeads) {
        let distance = null;
        if (lead.address && client.location) {
          distance = await calculateDistance(client.location, lead.address, GOOGLE_MAPS_API_KEY);
        }
        leadsWithDistances.push({ ...lead, distance_miles: distance });
        await sleep(150);
      }
      const withDistance = leadsWithDistances.filter(l => l.distance_miles !== null);
      console.log(`✅ Distance calculated for ${withDistance.length}/${leadsWithDistances.length} leads`);
    } else {
      leadsWithDistances = qualifiedLeads.map(l => ({ ...l, distance_miles: null }));
    }

    // STEP 9: Write emails
    console.log('\n✍️  Writing personalised emails...');
    const leadsWithEmails = [];

    for (const lead of leadsWithDistances) {
      const emailContent = await writeEmail(client, lead);
      leadsWithEmails.push({ ...lead, ...emailContent });
      await sleep(300);
    }

    // STEP 10: Save to Supabase
    console.log('\n💾 Saving leads to database...');
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
        postcode: lead.postcode || null,
        business_type: lead.container_type || null,
        description: lead.description || null,
        source: lead.source,
        source_id: lead.source_id || null,
        container_type: lead.container_type || null,
        buyer_archetype: lead.buyer_archetype || null,
        source_metadata: lead.source_metadata || {},
        fit_score: lead.fit_score,
        fit_reason: lead.fit_reason,
        distance_miles: lead.distance_miles || null,
        matches_perfect_lead_def: lead.matches_perfect_lead_def || false,
        enrichment_data: lead.enrichment_data || null,
        enrichment_status: lead.enrichment_status || null,
        enriched_at: lead.enrichment_data ? new Date().toISOString() : null,
        email_subject: lead.email_subject,
        email_body: lead.email_body,
        follow_up_body: lead.follow_up_body,
        status: 'new',
      }));

      const { error } = await supabase
        .from('leads')
        .upsert(leadsToInsert, {
          onConflict: 'client_id,source,source_id',
          ignoreDuplicates: true,
        });

      if (error) console.error('Batch save error:', error.message);
      else savedCount += batch.length;
    }

    console.log(`✅ Saved ${savedCount} leads`);

    // STEP 11: Update records
    await supabase.from('campaigns').update({
      status: 'complete',
      leads_found: allLeads.length,
      leads_qualified: qualifiedLeads.length,
      emails_drafted: leadsWithEmails.length,
      completed_at: new Date().toISOString(),
    }).eq('id', campaign.id);

    await supabase.from('clients')
      .update({ last_campaign_run: new Date().toISOString() })
      .eq('id', client.id);

    console.log(`\n🎉 Campaign complete! Found: ${allLeads.length} | Qualified: ${qualifiedLeads.length} | Perfect: ${perfectMatches} ⭐ | Enriched: ${enrichedCount} 🌐 | Saved: ${savedCount}`);

  } catch (err) {
    console.error('Campaign failed:', err.message);
    await supabase.from('campaigns').update({
      status: 'failed',
      error_message: err.message,
      completed_at: new Date().toISOString(),
    }).eq('id', campaign.id);
  }
};

// ============================================
// ENTRY POINT
// ============================================
const main = async () => {
  console.log('🔄 TradeFlow Agent Starting...');
  console.log(`   Time: ${new Date().toISOString()}`);
  console.log(`   Firecrawl: ${FIRECRAWL_ENABLED ? '✅ enabled' : '⚠️  disabled'}`);

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
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
