// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from 'node:fs/promises';
import { GitHub } from '../lib/github.mjs';
import { mergeState } from '../lib/state.mjs';
import { REPOSITORY, STATE_BRANCH, invariant, reportFailure, log } from '../lib/common.mjs';
try {
  invariant(process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_REF === 'refs/heads/main', 'TRUSTED_MAIN_REQUIRED');
  const github = new GitHub(), results = [];
  for (const name of (await readdir('results')).filter(name => /^ubuntu(?:24|26)\.json$/.test(name))) results.push(JSON.parse(await readFile(`results/${name}`, 'utf8')));
  invariant(results.length > 0, 'CHECK_RESULTS_MISSING');
  // Read current status-branch state so a queued workflow cannot replace newer public metadata.
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await github.json(`/repos/${REPOSITORY}/contents/images.json?ref=${STATE_BRANCH}`);
    const state = JSON.parse(Buffer.from(current.content, 'base64').toString('utf8'));
    const content = Buffer.from(`${JSON.stringify(mergeState(state, results), null, 2)}\n`).toString('base64');
    const response = await github.request(`/repos/${REPOSITORY}/contents/images.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Record hosted image check and publication results', content, sha: current.sha, branch: STATE_BRANCH }) });
    if (response.ok) { log('publication_state_recorded', { checks: results.length }); break; }
    invariant(response.status === 409 && attempt < 3, 'PUBLICATION_STATE_WRITE_FAILED');
  }
} catch (error) { reportFailure(error); process.exitCode = 1; }
