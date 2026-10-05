// SPDX-License-Identifier: Apache-2.0
import { requireHosted, reportFailure } from '../lib/common.mjs';
import { Registry } from '../lib/registry.mjs';
try { requireHosted(process.argv[2]); await new Registry().ensurePrivate(); }
catch (error) { reportFailure(error); process.exitCode = 1; }
