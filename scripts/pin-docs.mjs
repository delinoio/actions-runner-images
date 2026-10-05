// SPDX-License-Identifier: Apache-2.0
import { appendFile } from 'node:fs/promises';
import { GitHub } from '../lib/github.mjs';
import { invariant, REPOSITORY, reportFailure, log } from '../lib/common.mjs';
try {
  invariant(process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_REF === 'refs/heads/main', 'TRUSTED_MAIN_REQUIRED');
  const commit = await new GitHub().json('/repos/actions/runner-images/commits/main');
  invariant(/^[a-f0-9]{40}$/.test(commit.sha), 'DOCS_REVISION_UNRESOLVED');
  await appendFile(process.env.GITHUB_OUTPUT, `revision=${commit.sha}\n`);
  log('runner_docs_pinned', { revision: commit.sha });
} catch (error) { reportFailure(error); process.exitCode = 1; }
