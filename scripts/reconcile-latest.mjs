// SPDX-License-Identifier: Apache-2.0
import { GitHub } from '../lib/github.mjs';
import { Registry } from '../lib/registry.mjs';
import { readJSON, jsonFile, requireHosted, ubuntu, invariant, reportFailure, log, REPOSITORY, STATE_BRANCH } from '../lib/common.mjs';
const os = process.argv[2];
try {
  requireHosted(os); const resultPath = `results/${ubuntu(os)}.json`, result = await readJSON(resultPath);
  if (result.available && result.latestOS === os) {
    const metadata = await new GitHub().json(`/repos/${REPOSITORY}/contents/images.json?ref=${STATE_BRANCH}`);
    const state = JSON.parse(Buffer.from(metadata.content, 'base64').toString('utf8')), accepted = state.images[os].published;
    invariant(accepted?.validation?.digest === accepted.digest, 'LATEST_ACCEPTANCE_RECORD_REQUIRED');
    const registry = new Registry(); await registry.ensurePrivate(); const target = await registry.getManifest(`ubuntu-${os}`);
    invariant(target?.digest === accepted.digest, 'LATEST_ACCEPTED_ALIAS_MISMATCH');
    const old = await registry.getManifest('latest');
    if (old?.digest !== target.digest) {
      try { await registry.putManifest('latest', target.body); }
      catch (error) { if (old) await registry.putManifest('latest', old.body); throw error; }
      log('latest_alias_reconciled', { os, digest: target.digest });
    }
    await jsonFile(resultPath, { ...result, latestDigest: target.digest });
  }
} catch (error) { reportFailure(error); process.exitCode = 1; }
