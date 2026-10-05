// SPDX-License-Identifier: Apache-2.0
import { writeFile } from 'node:fs/promises';
import { GitHub } from '../lib/github.mjs';
import { Registry } from '../lib/registry.mjs';
import { latestUbuntu } from '../lib/source.mjs';
import { trustedSourceRun, publicEvents, recoveredCandidate } from '../lib/recovery.mjs';
import { requireHosted, invariant, readJSON, jsonFile, command, childEnvironment, reportFailure, log, REPOSITORY, ubuntu } from '../lib/common.mjs';
const os = process.argv[2];
try {
  requireHosted(os); invariant(/^\d+$/.test(process.env.SOURCE_RUN_ID ?? ''), 'SOURCE_RUN_ID_REQUIRED');
  const github = new GitHub(), run = await github.json(`/repos/${REPOSITORY}/actions/runs/${process.env.SOURCE_RUN_ID}`);
  trustedSourceRun(run);
  const jobs = await github.json(`/repos/${REPOSITORY}/actions/runs/${run.id}/jobs?per_page=100`);
  const job = jobs.jobs.find(item => item.name === `images (${os})` && item.status === 'completed');
  invariant(job && Number.isSafeInteger(job.id), 'COMPLETED_SOURCE_JOB_REQUIRED');
  const logs = await command('gh', ['api', '--allow-escape-sequences', `repos/${REPOSITORY}/actions/jobs/${job.id}/logs`], { env: { ...childEnvironment(), GH_TOKEN: process.env.GITHUB_TOKEN } });
  const source = await readJSON(`.work/original/${ubuntu(os)}.json`), inventory = await readJSON(`.work/original/${ubuntu(os)}-inventory.json`);
  invariant(source.imageVersion === process.env.ImageVersion, 'RECOVERY_HOST_VERSION_MISMATCH');
  const registry = new Registry(); await registry.ensurePrivate();
  const tag = `candidate-${ubuntu(os)}-${run.id}-${run.run_attempt}`, manifest = await registry.getManifest(tag);
  const candidate = recoveredCandidate(run, os, source, inventory, publicEvents(logs), manifest);
  // Keep the original build revision/hash. Recovery changes verification only,
  // and must not claim the old filesystem was built by the current recipe.
  candidate.source.docsRevision = process.env.RUNNER_DOCS_REVISION;
  candidate.source.latestOS = latestUbuntu(await github.contents('README.md', candidate.source.docsRevision));
  candidate.source.latestError = null; delete candidate.source.code;
  await jsonFile('.work/candidate.json', candidate); await writeFile('.work/manifest.json', manifest.body);
  await jsonFile('.work/inventory.json', inventory); await jsonFile(`results/${ubuntu(os)}.json`, candidate.source);
  await jsonFile(`results/${ubuntu(os)}-inventory.json`, inventory);
  log('candidate_resumed', { os, sourceRun: run.id, digest: candidate.digest });
} catch (error) { reportFailure(error); process.exitCode = 1; }
