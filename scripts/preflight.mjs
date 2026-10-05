// SPDX-License-Identifier: Apache-2.0
import { requireHosted, reportFailure, log } from '../lib/common.mjs';
import { Registry } from '../lib/registry.mjs';
try {
  requireHosted(process.argv[2]); const registry = new Registry(); await registry.ensurePrivate();
  // Exercise more than one real PATCH before collecting or exporting software.
  // This deterministic fixture contains no host data or licensed payload.
  const descriptor = await registry.uploadBuffer(Buffer.alloc(registry.chunkSize + 17, 0x52));
  log('registry_chunk_roundtrip_verified', descriptor);
}
catch (error) { reportFailure(error); process.exitCode = 1; }
