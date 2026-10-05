// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedSourceRun, publicEvents, recoveredCandidate } from '../lib/recovery.mjs';
import { sha256, REPOSITORY } from '../lib/common.mjs';
import { MEDIA } from '../lib/registry.mjs';
const run = { id: 123, run_attempt: 1, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, head_branch: 'main', event: 'push', path: '.github/workflows/publish.yml', head_sha: 'a'.repeat(40) };
function fixture() {
  const source = { os: '26.04', imageOS: 'ubuntu26', available: true, recipeRevision: run.head_sha, recipeHash: 'b'.repeat(64), sourceRevision: 'c'.repeat(40) }, inventory = { report: {}, aptPackages: ['tool\t1'] };
  const layer = { mediaType: MEDIA.layer, digest: `sha256:${'d'.repeat(64)}`, size: 123 };
  const manifestObject = { schemaVersion: 2, mediaType: MEDIA.manifest, layers: [layer] };
  const body = Buffer.from(JSON.stringify(manifestObject)), manifest = { body, digest: sha256(body), manifest: manifestObject };
  const events = [{ event: 'layer_uploaded', index: 0, digest: 'preflight' }, { event: 'inventory_collected', os: '26.04', inventoryHash: sha256(JSON.stringify(inventory)) }, { event: 'snapshot_planned', os: '26.04' }, { event: 'layer_uploaded', index: 0, digest: layer.digest, diff_id: `sha256:${'e'.repeat(64)}`, bytes: layer.size, uncompressed: 456 }, { event: 'candidate_exported', os: '26.04', digest: manifest.digest, layers: 1 }];
  return { source, inventory, events, manifest };
}
test('recovery requires an exact trusted-main publication run', () => {
  trustedSourceRun(run);
  for (const changed of [{ head_branch: 'feature' }, { event: 'pull_request' }, { path: '.github/workflows/test.yml' }, { head_repository: { full_name: 'external/fork' } }]) assert.throws(() => trustedSourceRun({ ...run, ...changed }), /TRUSTED_SOURCE_RUN_REQUIRED/);
});
test('recovery preserves the original recipe and validates inventories, descriptors and digest', () => {
  const f = fixture(), candidate = recoveredCandidate(run, '26.04', f.source, f.inventory, f.events, f.manifest);
  assert.equal(candidate.candidate, 'candidate-ubuntu26-123-1'); assert.equal(candidate.uncompressed, 456); assert.equal(candidate.source.recipeRevision, run.head_sha);
  assert.throws(() => recoveredCandidate(run, '26.04', f.source, { ...f.inventory, aptPackages: [] }, f.events, f.manifest), /RECOVERY_INVENTORY_MISMATCH/);
  assert.throws(() => recoveredCandidate(run, '26.04', { ...f.source, recipeRevision: 'f'.repeat(40) }, f.inventory, f.events, f.manifest), /RECOVERY_SOURCE_MISMATCH/);
  assert.throws(() => recoveredCandidate(run, '26.04', f.source, f.inventory, f.events, { ...f.manifest, digest: `sha256:${'f'.repeat(64)}` }), /RECOVERY_CANDIDATE_UNCONFIRMED/);
  const wrong = structuredClone(f.manifest); wrong.manifest.layers[0].size++;
  assert.throws(() => recoveredCandidate(run, '26.04', f.source, f.inventory, f.events, wrong), /RECOVERY_MANIFEST_MISMATCH/);
});
test('public event parsing ignores command and non-JSON log text', () => {
  assert.deepEqual(publicEvents('other text\n2026-10-05T00:00:00Z {"time":"2026-10-05T00:00:00Z","event":"snapshot_planned"}\ninvalid'), [{ time: '2026-10-05T00:00:00Z', event: 'snapshot_planned' }]);
});
