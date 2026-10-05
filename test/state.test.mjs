// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeState } from '../lib/state.mjs';
import { IMAGE } from '../lib/common.mjs';
const initial = () => ({ schemaVersion: 1, image: IMAGE, latestOS: null, images: { '24.04': { published: null, history: [] }, '26.04': { published: null, history: [] } } });
test('failed checks preserve prior publication and successful history is bounded', () => {
  let state = initial();
  for (let i = 0; i < 6; i++) {
    const digest = `sha256:${String(i).repeat(64)}`;
    state = mergeState(state, [{ os: '24.04', status: 'published', latestOS: '24.04', published: { imageVersion: `2026100${i + 1}.1.1`, digest, validation: { digest, softwareInventory: 'passed', aptInventory: 'passed', sandboxCompilation: 'passed' } } }]);
  }
  assert.equal(state.images['24.04'].history.length, 4);
  const failed = mergeState(state, [{ os: '24.04', status: 'failed', code: 'SOFTWARE_INVENTORY_MISMATCH' }]);
  assert.deepEqual(failed.images['24.04'].published, state.images['24.04'].published);
  assert.equal(failed.images['24.04'].lastCheck.code, 'SOFTWARE_INVENTORY_MISMATCH');
});
test('state rejects unverified publication and source downgrades', () => {
  assert.throws(() => mergeState(initial(), [{ os: '24.04', status: 'published', published: { digest: 'bad' } }]), /UNVERIFIED_STATE_PUBLICATION/);
});
