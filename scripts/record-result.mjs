// SPDX-License-Identifier: Apache-2.0
import { readJSON, jsonFile, ubuntu } from '../lib/common.mjs';
const os = process.argv[2], resultPath = `results/${ubuntu(os)}.json`;
let result;
try { result = await readJSON(resultPath); }
catch { result = { os, checkedAt: new Date().toISOString() }; }
const jobResult = process.env.JOB_RESULT;
if (jobResult !== 'success' && result.status !== 'published') {
  let code = null;
  try { const failure = await readJSON('.work/failure.json'); if (/^[A-Z0-9_]+$/.test(failure.code)) code = failure.code; } catch { /* Cancellation may have no exporter error. */ }
  result = { ...result, status: jobResult === 'cancelled' ? 'cancelled' : 'failed', code };
}
await jsonFile(resultPath, result);
