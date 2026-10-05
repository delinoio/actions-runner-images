// SPDX-License-Identifier: Apache-2.0
import { invariant } from './common.mjs';

// Older exports omitted the extension lookup variable, while preserving the
// installed /opt/az payload. This narrowly scoped recovery avoids exporting the
// filesystem again. Remove it after candidates from that recipe have expired.
export function restoreAzureExtensionDefault(inspected, candidate, environment, revision) {
  invariant(/^[a-f0-9]{40}$/.test(revision ?? ''), 'CONFIGURATION_REPAIR_REVISION_REQUIRED');
  invariant(inspected.Os === 'linux' && inspected.Architecture === 'amd64' && inspected.Config.User === 'runner' && !Object.keys(inspected.Config.Volumes ?? {}).length, 'CONFIGURATION_REPAIR_IMAGE_MISMATCH');
  invariant(JSON.stringify(inspected.RootFS.Layers) === JSON.stringify(candidate.layers.map(layer => layer.diff_id)), 'CONFIGURATION_REPAIR_ROOTFS_MISMATCH');
  invariant(inspected.Config.Labels?.['org.opencontainers.image.revision'] === candidate.source.recipeRevision && inspected.Config.Labels?.['io.delino.runner-images.inventory-sha256'] === candidate.source.inventoryHash, 'CONFIGURATION_REPAIR_PROVENANCE_MISMATCH');
  const defaults = environment.filter(value => value.startsWith('AZURE_EXTENSION_DIR='));
  invariant(defaults.length === 1 && defaults[0] === 'AZURE_EXTENSION_DIR=/opt/az/azcliextensions', 'AZURE_EXTENSION_DEFAULT_CHANGED');
  const existing = inspected.Config.Env.filter(value => value.startsWith('AZURE_EXTENSION_DIR='));
  invariant(existing.length === 0 || (existing.length === 1 && existing[0] === defaults[0]), 'AZURE_EXTENSION_OVERRIDE_FORBIDDEN');
  if (existing.length) return null;
  const config = structuredClone(inspected.Config);
  config.Env.push(defaults[0]);
  config.Labels['io.delino.runner-images.configuration-revision'] = revision;
  const configurationRepair = { revision, originalDigest: candidate.digest, restoredDefaults: ['AZURE_EXTENSION_DIR'] };
  return {
    configurationRepair,
    config: { created: inspected.Created, architecture: inspected.Architecture, os: inspected.Os, config, rootfs: { type: 'layers', diff_ids: [...inspected.RootFS.Layers] }, history: [{ created: new Date().toISOString(), created_by: 'Restored installed Azure CLI extension lookup default', empty_layer: true }] },
  };
}
