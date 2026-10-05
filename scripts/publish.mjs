// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { Registry } from '../lib/registry.mjs';
import { retentionPlan } from '../lib/retention.mjs';
import { requireHosted, readJSON, jsonFile, ubuntu, invariant, compareVersion, reportFailure, log, IMAGE } from '../lib/common.mjs';
const os = process.argv[2];
try {
  requireHosted(os); const candidate = await readJSON('.work/candidate.json'), verified = await readJSON('.work/verified.json');
  invariant(candidate.digest === verified.digest && verified.softwareInventory === 'passed' && verified.aptInventory === 'passed' && verified.sandboxCompilation === 'passed', 'CANDIDATE_ACCEPTANCE_REQUIRED');
  const registry = new Registry(); await registry.ensurePrivate();
  const body = await readFile('.work/manifest.json');
  const alias = `ubuntu-${os}`, current = await registry.getManifest(alias);
  if (current) {
    const response = await registry.request(`blobs/${current.manifest.config.digest}`); invariant(response.ok, 'CURRENT_IMAGE_CONFIG_UNAVAILABLE');
    const config = await response.json(); const version = config.config.Env.find(value => value.startsWith('ImageVersion='))?.slice('ImageVersion='.length);
    invariant(version && compareVersion(candidate.source.imageVersion, version) >= 0, 'REGISTRY_ALIAS_DOWNGRADE');
  }
  const immutable = `${ubuntu(os)}-${candidate.source.imageVersion}-${candidate.source.recipeHash.slice(0, 12)}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const aliases = candidate.source.latestOS === os ? [alias, 'latest'] : [alias];
  const digest = await registry.promote(body, immutable, aliases);
  const published = { imageVersion: candidate.source.imageVersion, recipeHash: candidate.source.recipeHash, recipeRevision: candidate.source.recipeRevision, sourceRevision: candidate.source.sourceRevision, releaseTag: candidate.source.releaseTag, inventoryHash: candidate.source.inventoryHash, digest, ref: `${IMAGE}@${digest}`, tag: immutable, publishedAt: new Date().toISOString(), validation: verified, layers: candidate.layers.map(({ digest, size, uncompressed }) => ({ digest, size, uncompressed })) };
  // Persist publication acceptance before cleanup: a retention error must not erase a successful promotion.
  await jsonFile(`results/${ubuntu(os)}.json`, { ...candidate.source, status: 'published', published });
  const protectedDigests = new Set();
  for (const tag of ['ubuntu-24.04', 'ubuntu-26.04', 'latest']) { const manifest = await registry.getManifest(tag); if (manifest) protectedDigests.add(manifest.digest); }
  try {
    for (const id of retentionPlan(await registry.versions(), protectedDigests)) { await registry.deleteVersion(id); log('owned_package_version_deleted', { id }); }
  } catch (error) {
    await jsonFile(`results/${ubuntu(os)}.json`, { ...candidate.source, status: 'published', published, maintenanceError: error.code ?? 'RETENTION_FAILED' });
    throw error;
  }
  log('image_published', { os, digest, tag: immutable });
} catch (error) { reportFailure(error); process.exitCode = 1; }
