// SPDX-License-Identifier: Apache-2.0
import { requireHosted, reportFailure, log } from '../lib/common.mjs';
import { Registry } from '../lib/registry.mjs';
import { exportLayer } from '../lib/snapshot.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
let fixture;
try {
  requireHosted(process.argv[2]); const registry = new Registry(); await registry.ensurePrivate();
  // Exercise a streamed body larger than typical transport buffers before export.
  // This deterministic fixture contains no host data or licensed payload.
  const descriptor = await registry.uploadBuffer(Buffer.alloc(registry.chunkSize + 17, 0x52));
  log('registry_stream_roundtrip_verified', descriptor);
  // Include a tiny, quickly completed compressor output, like the metadata
  // supplement. This also exercises buffering while upload creation waits.
  fixture = await mkdtemp(path.join(tmpdir(), 'runner-image-preflight-'));
  await writeFile(path.join(fixture, 'proof.txt'), Buffer.alloc(1024 * 1024, 0x52));
  const small = await exportLayer(registry, fixture, { files: ['proof.txt'] }, path.join(fixture, 'lists'), 0);
  log('registry_compressed_roundtrip_verified', { digest: small.digest, size: small.size });
}
catch (error) { reportFailure(error); process.exitCode = 1; }
finally { if (fixture) await rm(fixture, { recursive: true, force: true }); }
