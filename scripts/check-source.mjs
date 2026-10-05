// SPDX-License-Identifier: Apache-2.0
import { appendFile } from 'node:fs/promises';
import { checkSource, fingerprint, shouldBuild } from '../lib/source.mjs';
import { requireHosted, readJSON, jsonFile, reportFailure, ubuntu, log } from '../lib/common.mjs';
const os = process.argv[2] ?? '24.04';
try {
  requireHosted(os);
  const source = await checkSource(os);
  const state = await readJSON('images.json'); const recipeHash = await fingerprint();
  const build = source.available && shouldBuild(state.images[os], process.env.ImageVersion, recipeHash, process.env.FORCE_BUILD === 'true');
  const result = { os, imageOS: ubuntu(os), imageVersion: process.env.ImageVersion, recipeRevision: process.env.GITHUB_SHA, recipeHash, ...source, build, checkedAt: new Date().toISOString(), status: build ? 'pending' : (source.available ? 'unchanged' : 'waiting-for-release') };
  await jsonFile(`results/${ubuntu(os)}.json`, result);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `build=${build}\n`);
  log('source_checked', { os, imageVersion: result.imageVersion, build, status: result.status });
} catch (error) {
  await jsonFile(`results/${ubuntu(os)}.json`, { os, checkedAt: new Date().toISOString(), status: 'failed', code: error.code ?? 'SOURCE_CHECK_FAILED' });
  reportFailure(error); process.exitCode = 1;
}
