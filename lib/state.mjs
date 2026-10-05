// SPDX-License-Identifier: Apache-2.0
import { IMAGE, invariant, compareVersion } from './common.mjs';
export function mergeState(state, results) {
  invariant(state.schemaVersion === 1 && state.image === IMAGE, 'STATE_SCHEMA_MISMATCH');
  const next = structuredClone(state);
  for (const result of results) {
    invariant(['24.04', '26.04'].includes(result.os), 'UNSUPPORTED_STATE_OS');
    const slot = next.images[result.os];
    slot.lastCheck = { checkedAt: result.checkedAt, status: result.status, imageVersion: result.imageVersion ?? null, recipeRevision: result.recipeRevision ?? null, code: result.code ?? null, latestError: result.latestError ?? null, maintenanceError: result.maintenanceError ?? null };
    if (result.latestOS) next.latestOS = result.latestOS;
    if (result.status !== 'published') continue;
    const published = result.published;
    invariant(published?.validation?.softwareInventory === 'passed' && published?.validation?.aptInventory === 'passed' && published?.validation?.sandboxCompilation === 'passed' && published?.validation?.digest === published.digest && /^sha256:[a-f0-9]{64}$/.test(published.digest), 'UNVERIFIED_STATE_PUBLICATION');
    if (slot.published) invariant(compareVersion(published.imageVersion, slot.published.imageVersion) >= 0, 'STATE_VERSION_DOWNGRADE');
    slot.history = [published, ...slot.history.filter(item => item.digest !== published.digest)].slice(0, 4);
    slot.published = published;
  }
  return next;
}
