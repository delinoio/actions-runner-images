// SPDX-License-Identifier: Apache-2.0
import { requireHosted, reportFailure, log, invariant, sha256 } from '../lib/common.mjs';
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
  // Subsequent publications read the prior configuration before enforcing the
  // no-downgrade rule. Verify that actual read path before a large export starts.
  for (const os of ['24.04', '26.04']) {
    const current = await registry.getManifest(`ubuntu-${os}`); if (!current) continue;
    const response = await registry.request(`blobs/${current.manifest.config.digest}`);
    invariant(response.ok, 'CURRENT_IMAGE_CONFIG_UNAVAILABLE');
    const body = Buffer.from(await response.arrayBuffer());
    invariant(sha256(body) === current.manifest.config.digest && body.length === current.manifest.config.size, 'CURRENT_CONFIG_ROUNDTRIP_MISMATCH');
    const config = JSON.parse(body);
    invariant(config.os === 'linux' && config.architecture === 'amd64' && config.config.User === 'runner' && config.config.Env.some(value => /^ImageVersion=\d+(\.\d+)+$/.test(value)), 'CURRENT_CONFIG_INVALID');
    log('registry_existing_config_verified', { os, digest: current.digest });
  }
}
catch (error) { reportFailure(error); process.exitCode = 1; }
finally { if (fixture) await rm(fixture, { recursive: true, force: true }); }
