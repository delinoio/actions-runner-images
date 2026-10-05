// SPDX-License-Identifier: Apache-2.0
import { invariant, sha256, REPOSITORY, ubuntu } from './common.mjs';
import { MEDIA } from './registry.mjs';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export function trustedSourceRun(run) {
  invariant(run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY && run.head_branch === 'main' && ['push', 'schedule', 'workflow_dispatch'].includes(run.event) && run.path === '.github/workflows/publish.yml' && /^[a-f0-9]{40}$/.test(run.head_sha) && Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'TRUSTED_SOURCE_RUN_REQUIRED');
}
export function publicEvents(logs) {
  const events = [];
  for (const line of logs.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n')) {
    const start = line.indexOf('{"time":'); if (start < 0) continue;
    try { const event = JSON.parse(line.slice(start)); if (typeof event.event === 'string') events.push(event); } catch { /* Ignore non-event job text. */ }
  }
  return events;
}
export function recoveredCandidate(run, os, source, inventory, events, manifest) {
  trustedSourceRun(run);
  invariant(source.os === os && source.imageOS === ubuntu(os) && source.recipeRevision === run.head_sha && /^[a-f0-9]{64}$/.test(source.recipeHash) && /^[a-f0-9]{40}$/.test(source.sourceRevision) && source.available === true, 'RECOVERY_SOURCE_MISMATCH');
  const collected = events.find(event => event.event === 'inventory_collected' && event.os === os);
  const inventoryHash = sha256(JSON.stringify(inventory));
  invariant(collected?.inventoryHash === inventoryHash, 'RECOVERY_INVENTORY_MISMATCH');
  const planned = events.findIndex(event => event.event === 'snapshot_planned' && event.os === os);
  invariant(planned >= 0, 'RECOVERY_LAYER_EVENTS_MISSING');
  const layers = events.slice(planned + 1).filter(event => event.event === 'layer_uploaded').map((event, index) => {
    invariant(event.index === index && DIGEST.test(event.digest) && DIGEST.test(event.diff_id) && Number.isSafeInteger(event.bytes) && event.bytes > 0 && Number.isSafeInteger(event.uncompressed) && event.uncompressed > 0, 'RECOVERY_LAYER_INVALID');
    return { mediaType: MEDIA.layer, digest: event.digest, size: event.bytes, diff_id: event.diff_id, uncompressed: event.uncompressed };
  });
  const exported = events.find(event => event.event === 'candidate_exported' && event.os === os);
  invariant(exported && manifest && manifest.digest === exported.digest && layers.length === exported.layers && layers.length > 0 && layers.length <= 120, 'RECOVERY_CANDIDATE_UNCONFIRMED');
  invariant(manifest.manifest.schemaVersion === 2 && manifest.manifest.mediaType === MEDIA.manifest && JSON.stringify(manifest.manifest.layers) === JSON.stringify(layers.map(({ mediaType, digest, size }) => ({ mediaType, digest, size }))), 'RECOVERY_MANIFEST_MISMATCH');
  const candidate = `candidate-${ubuntu(os)}-${run.id}-${run.run_attempt}`;
  return { candidate, digest: manifest.digest, layers, uncompressed: layers.reduce((sum, layer) => sum + layer.uncompressed, 0), source: { ...source, inventoryHash, status: 'pending', checkedAt: new Date().toISOString() } };
}
