// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { checkSource, prepareReport, generateReport, normalizeReport } from '../lib/source.mjs';
import { staticEnvironment } from '../lib/snapshot.mjs';
import { readJSON, jsonFile, requireHosted, ubuntu, command, sha256, reportFailure, log, invariant } from '../lib/common.mjs';
const os = process.argv[2];
try {
  requireHosted(os); const check = await readJSON(`results/${ubuntu(os)}.json`);
  invariant(check.build && check.sourceRevision, 'CHECK_REQUIRED');
  const reporter = path.resolve('.work/reporter'); await prepareReport(check.sourceRevision, reporter, undefined, os);
  const report = normalizeReport(await generateReport(reporter, path.resolve('.work/source-report')));
  const aptPackages = await command('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\n']);
  const inventory = { report, aptPackages: aptPackages.trim().split('\n').sort() };
  await jsonFile('.work/inventory.json', inventory);
  await jsonFile('.work/environment.json', await staticEnvironment());
  await jsonFile('.work/source.json', { ...check, inventoryHash: sha256(JSON.stringify(inventory)) });
  // This artifact contains only software names and versions, never raw host or job content.
  await jsonFile(`results/${ubuntu(os)}-inventory.json`, inventory);
  log('inventory_collected', { os, inventoryHash: sha256(JSON.stringify(inventory)) });
} catch (error) { reportFailure(error); process.exitCode = 1; }
