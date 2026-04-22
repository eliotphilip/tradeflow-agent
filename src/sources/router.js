// src/sources/router.js
// Dispatches lead finding to the right source modules based on container types
// All intelligence lives in container_types.json — the router is just a dispatcher

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { fetchLeads as fetchFromCQC } from './cqc.js';
import { fetchLeads as fetchFromCompaniesHouse } from './companiesHouse.js';
import { fetchLeads as fetchFromGoogleMaps } from './googleMaps.js';

import { dedupeKey, mergeLeads } from './_shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'container_types.json');

// Registry of source modules — add new sources here
const SOURCES = {
  cqc: { fetchLeads: fetchFromCQC },
  companies_house: { fetchLeads: fetchFromCompaniesHouse },
  google_maps: { fetchLeads: fetchFromGoogleMaps },
};

let containerConfigCache = null;

async function loadContainerConfig() {
  if (containerConfigCache) return containerConfigCache;
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  containerConfigCache = Object.fromEntries(parsed.containers.map((c) => [c.id, c]));
  return containerConfigCache;
}

function planFetchesForContainer(container) {
  const sources = [
    container.primary_data_source,
    ...(container.secondary_data_sources ?? []),
  ]
    .filter(Boolean)
    .filter((s) => SOURCES[s]);

  return sources.map((sourceId) => ({ sourceId, container }));
}

/**
 * Main entry point — fetches leads for a client based on their target container types
 *
 * @param {Object} args
 * @param {Object} args.client - Client record from Supabase
 * @param {number} [args.perContainerLimit=60] - Max leads per container type
 * @param {number} [args.concurrency=3] - Max parallel fetch jobs
 * @returns {Promise<{ leads: NormalisedLead[], stats: Object }>}
 */
export async function fetchLeadsForClient({
  client,
  perContainerLimit = 60,
  concurrency = 3,
}) {
  if (!client?.target_container_types?.length) {
    console.log('⚠️  No target_container_types set — falling back to trade-based search');
    return { leads: [], stats: { reason: 'no_target_container_types' } };
  }

  const containerConfig = await loadContainerConfig();

  const jobs = [];
  const missingContainers = [];

  for (const containerId of client.target_container_types) {
    const container = containerConfig[containerId];
    if (!container) {
      missingContainers.push(containerId);
      continue;
    }
    jobs.push(...planFetchesForContainer(container));
  }

  if (jobs.length === 0) {
    return { leads: [], stats: { reason: 'no_valid_containers', missingContainers } };
  }

  console.log(`📋 Planned ${jobs.length} fetch jobs across ${client.target_container_types.length} container types`);

  // Execute with bounded concurrency
  const results = [];
  const errors = [];
  const queue = [...jobs];

  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      const { sourceId, container } = job;
      const source = SOURCES[sourceId];

      try {
        console.log(`   → ${sourceId}: ${container.display_name}`);
        const leads = await source.fetchLeads({
          container,
          client,
          limit: perContainerLimit,
        });

        // Stamp container and archetype
        for (const lead of leads) {
          lead.container_type = container.id;
          lead.buyer_archetype = container.buyer_archetype;
        }

        results.push(...leads);
      } catch (err) {
        errors.push({
          source: sourceId,
          container: container.id,
          error: err.message,
        });
        console.error(`   ❌ ${sourceId}/${container.id}: ${err.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker())
  );

  // Dedupe across sources
  const byKey = new Map();
  for (const lead of results) {
    const key = dedupeKey(lead);
    if (!byKey.has(key)) {
      byKey.set(key, lead);
    } else {
      byKey.set(key, mergeLeads(byKey.get(key), lead));
    }
  }
  const deduped = [...byKey.values()];

  const stats = {
    total_fetched: results.length,
    unique_leads: deduped.length,
    duplicates_merged: results.length - deduped.length,
    jobs_run: jobs.length,
    errors,
    missing_containers: missingContainers,
  };

  console.log(`📊 Router: ${results.length} fetched → ${deduped.length} unique (${results.length - deduped.length} duplicates merged)`);

  return { leads: deduped, stats };
}
