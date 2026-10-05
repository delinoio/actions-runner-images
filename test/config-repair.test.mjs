// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { restoreAzureExtensionDefault } from '../lib/config-repair.mjs';
import { staticEnvironment } from '../lib/snapshot.mjs';
const revision = 'a'.repeat(40), diff = `sha256:${'b'.repeat(64)}`;
function fixture() {
  const candidate = { digest: `sha256:${'c'.repeat(64)}`, layers: [{ diff_id: diff }], source: { recipeRevision: 'd'.repeat(40), inventoryHash: `sha256:${'e'.repeat(64)}` } };
  const inspected = { Created: '2026-10-05T00:00:00Z', Os: 'linux', Architecture: 'amd64', RootFS: { Layers: [diff] }, Config: { User: 'runner', WorkingDir: '/home/runner', Cmd: ['/bin/bash'], Env: ['PATH=/usr/bin', 'HOME=/home/runner'], Labels: { 'org.opencontainers.image.revision': candidate.source.recipeRevision, 'io.delino.runner-images.inventory-sha256': candidate.source.inventoryHash } } };
  return { candidate, inspected };
}
test('configuration repair retains filesystem and original provenance while adding only the missing tool default', () => {
  const { candidate, inspected } = fixture(), original = structuredClone(inspected);
  const repair = restoreAzureExtensionDefault(inspected, candidate, ['AZURE_EXTENSION_DIR=/opt/az/azcliextensions', 'PATH=/other'], revision);
  assert.deepEqual(inspected, original); assert.deepEqual(repair.config.rootfs.diff_ids, inspected.RootFS.Layers);
  assert.deepEqual(repair.config.config.Env, [...inspected.Config.Env, 'AZURE_EXTENSION_DIR=/opt/az/azcliextensions']);
  assert.equal(repair.config.config.User, 'runner'); assert.equal(repair.config.config.Volumes, undefined);
  assert.equal(repair.config.config.Labels['org.opencontainers.image.revision'], candidate.source.recipeRevision);
  assert.equal(repair.config.config.Labels['io.delino.runner-images.configuration-revision'], revision);
  assert.deepEqual(repair.configurationRepair, { revision, originalDigest: candidate.digest, restoredDefaults: ['AZURE_EXTENSION_DIR'] });
});
test('configuration repair rejects mismatched payloads, provenance, defaults and overrides', () => {
  const { candidate, inspected } = fixture(), environment = ['AZURE_EXTENSION_DIR=/opt/az/azcliextensions'];
  assert.throws(() => restoreAzureExtensionDefault({ ...inspected, RootFS: { Layers: [] } }, candidate, environment, revision), /CONFIGURATION_REPAIR_ROOTFS_MISMATCH/);
  const wrong = structuredClone(inspected); wrong.Config.Labels['org.opencontainers.image.revision'] = revision;
  assert.throws(() => restoreAzureExtensionDefault(wrong, candidate, environment, revision), /CONFIGURATION_REPAIR_PROVENANCE_MISMATCH/);
  assert.throws(() => restoreAzureExtensionDefault(inspected, candidate, ['AZURE_EXTENSION_DIR=/private'], revision), /AZURE_EXTENSION_DEFAULT_CHANGED/);
  inspected.Config.Env.push('AZURE_EXTENSION_DIR=/private');
  assert.throws(() => restoreAzureExtensionDefault(inspected, candidate, environment, revision), /AZURE_EXTENSION_OVERRIDE_FORBIDDEN/);
  inspected.Config.Env.pop(); inspected.Config.Env.push(environment[0]);
  assert.equal(restoreAzureExtensionDefault(inspected, candidate, environment, revision), null);
});
test('the static environment preserves Azure extensions while excluding Azure credentials and configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-image-env-')), file = path.join(root, 'environment');
  const prior = process.env.AZURE_EXTENSION_DIR; delete process.env.AZURE_EXTENSION_DIR;
  try {
    await writeFile(file, 'PATH=/usr/bin\nAZURE_EXTENSION_DIR="/opt/az/azcliextensions"\nAZURE_CONFIG_DIR=/private\nAZURE_DEVOPS_EXT_PAT=fixture-private-value\n');
    const environment = await staticEnvironment(file);
    assert.ok(environment.includes('AZURE_EXTENSION_DIR=/opt/az/azcliextensions'));
    assert.ok(!environment.some(value => /AZURE_CONFIG_DIR|AZURE_DEVOPS_EXT_PAT|fixture-private-value/.test(value)));
  } finally { if (prior === undefined) delete process.env.AZURE_EXTENSION_DIR; else process.env.AZURE_EXTENSION_DIR = prior; await rm(root, { recursive: true, force: true }); }
});
