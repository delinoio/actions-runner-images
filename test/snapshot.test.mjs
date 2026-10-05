// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, link, symlink, lstat, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { enumerate, partition, exportLayer, imageConfig } from '../lib/snapshot.mjs';
import { command, sha256 } from '../lib/common.mjs';
import { MEDIA } from '../lib/registry.mjs';

class MemoryRegistry {
  blobs = new Map();
  async uploadStream(stream) { const data = []; for await (const chunk of stream) data.push(chunk); const body = Buffer.concat(data), digest = sha256(body); this.blobs.set(digest, body); return { digest, size: body.length }; }
}
test('GNU tar preserves executable modes, symlinks, hardlinks and completion markers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-image-fixture-')); const work = await mkdtemp(path.join(tmpdir(), 'runner-image-tar-'));
  const tar = process.platform === 'darwin' ? 'gtar' : 'tar'; const previous = process.env.TAR; process.env.TAR = tar;
  try {
    await mkdir(path.join(root, 'opt/hostedtoolcache/tool/1'), { recursive: true });
    await writeFile(path.join(root, 'opt/hostedtoolcache/tool/1/x64.complete'), '');
    await mkdir(path.join(root, 'usr/bin'), { recursive: true }); await writeFile(path.join(root, 'usr/bin/tool'), '#!/bin/sh\n');
    await chmod(path.join(root, 'usr/bin/tool'), 0o751); await link(path.join(root, 'usr/bin/tool'), path.join(root, 'usr/bin/tool-hardlink')); await symlink('tool', path.join(root, 'usr/bin/tool-symlink'));
    await mkdir(path.join(root, 'home/runner/.docker'), { recursive: true }); await writeFile(path.join(root, 'home/runner/.docker/config.json'), 'fixture-private-auth-value');
    const registry = new MemoryRegistry(), layers = partition(await enumerate(root)); assert.equal(layers.length, 1);
    const layer = await exportLayer(registry, root, layers[0], work, 0, ['fixture-private-auth-value']);
    const raw = gunzipSync(registry.blobs.get(layer.digest)); assert.equal(sha256(raw), layer.diff_id);
    const archive = path.join(work, 'layer.tar'); await writeFile(archive, raw); const unpacked = path.join(work, 'unpacked'); await mkdir(unpacked);
    await command(tar, ['--extract', '--file', archive, '--directory', unpacked]);
    const a = await lstat(path.join(unpacked, 'usr/bin/tool')), b = await lstat(path.join(unpacked, 'usr/bin/tool-hardlink'));
    assert.equal(a.mode & 0o777, 0o751); assert.equal(a.ino, b.ino); assert.equal((await lstat(path.join(unpacked, 'usr/bin/tool-symlink'))).isSymbolicLink(), true);
    await lstat(path.join(unpacked, 'opt/hostedtoolcache/tool/1/x64.complete'));
    await assert.rejects(lstat(path.join(unpacked, 'home/runner/.docker/config.json')));
  } finally { if (previous) process.env.TAR = previous; else delete process.env.TAR; await rm(root, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); }
});

test('exported OCI layers load into Docker and run with Runmoor sandbox restrictions', { skip: process.env.RUN_DOCKER_TESTS !== 'true' || process.platform !== 'linux' }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'runner-image-docker-')), root = path.join(work, 'root'); let tag, server;
  try {
    await mkdir(root);
    const binaries = ['/bin/sh', '/usr/bin/id', '/usr/bin/stat', '/bin/cat']; const dependencies = new Set();
    for (const binary of binaries) {
      const output = await command('ldd', [binary]); for (const match of output.matchAll(/\/[a-zA-Z0-9_./+-]+/g)) dependencies.add(match[0]);
    }
    for (const file of [...binaries, ...dependencies]) { const target = path.join(root, file.slice(1)); await mkdir(path.dirname(target), { recursive: true }); await cp(file, target, { dereference: true }); }
    await mkdir(path.join(root, 'etc')); await writeFile(path.join(root, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/sh\nrunner:x:1001:1001:runner:/home/runner:/bin/sh\n');
    await writeFile(path.join(root, 'etc/group'), 'root:x:0:\nrunner:x:1001:\n'); await mkdir(path.join(root, 'home/runner'), { recursive: true });
    await writeFile(path.join(root, 'proof.txt'), 'fixture'); await chmod(path.join(root, 'proof.txt'), 0o640); await symlink('proof.txt', path.join(root, 'proof-link')); await link(path.join(root, 'proof.txt'), path.join(root, 'proof-hardlink'));
    const registry = new MemoryRegistry(), layers = [];
    for (const [index, layer] of partition(await enumerate(root)).entries()) layers.push(await exportLayer(registry, root, layer, work, index));
    const configBody = Buffer.from(JSON.stringify(imageConfig(['PATH=/usr/bin:/bin', 'HOME=/home/runner'], layers, {})));
    const configDigest = sha256(configBody); registry.blobs.set(configDigest, configBody);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: MEDIA.manifest, config: { mediaType: MEDIA.config, digest: configDigest, size: configBody.length }, layers: layers.map(({ digest, size, mediaType }) => ({ digest, size, mediaType })) }));
    const digest = sha256(manifest); registry.blobs.set(digest, manifest);
    server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/v2/' || url.pathname === '/v2') { response.writeHead(200, { 'Docker-Distribution-API-Version': 'registry/2.0' }); response.end(); return; }
      let body, type;
      if (url.pathname.startsWith('/v2/fixture/manifests/')) { body = manifest; type = MEDIA.manifest; }
      else if (url.pathname.startsWith('/v2/fixture/blobs/')) { body = registry.blobs.get(url.pathname.split('/').at(-1)); type = 'application/octet-stream'; }
      if (!body) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Docker-Content-Digest': sha256(body) });
      response.end(request.method === 'HEAD' ? undefined : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    tag = `127.0.0.1:${server.address().port}/fixture:acceptance`;
    await command('docker', ['pull', '--platform', 'linux/amd64', tag]);
    const output = await command('docker', ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', '/bin/sh', tag, '-c', 'test "$(id -u)" = 1001 && test "$(id -g)" = 1001 && test -L /proof-link && test "$(cat /proof-link)" = fixture && test "$(stat -c %a /proof.txt)" = 640 && test "$(stat -c %i /proof.txt)" = "$(stat -c %i /proof-hardlink)" && printf passed']);
    assert.equal(output, 'passed');
  } finally { if (server) await new Promise(resolve => server.close(resolve)); if (tag) await command('docker', ['image', 'rm', tag]).catch(() => {}); await rm(work, { recursive: true, force: true }); }
});
