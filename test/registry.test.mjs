// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Registry, MEDIA } from '../lib/registry.mjs';
import { sha256 } from '../lib/common.mjs';

class FakeRegistry {
  constructor() { this.uploads = new Map(); this.blobs = new Map(); this.manifests = new Map(); this.next = 0; this.patchCount = 0; this.losePatch = false; this.partialPatch = false; this.loseFinalize = false; this.failAlias = null; this.package = { name: 'actions-runner-images', package_type: 'container', visibility: 'private' }; }
  response(status, body = null, headers = {}) { return new Response(body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body)), { status, headers }); }
  async fetch(input, options = {}) {
    const url = new URL(input), method = options.method ?? 'GET', pathname = url.pathname;
    if (url.hostname === 'api.github.com') {
      if (pathname === '/user') return this.response(200, { login: 'kdy1' }, { 'X-OAuth-Scopes': 'write:packages, delete:packages' });
      return this.response(200, this.package);
    }
    if (pathname === '/token') return options.headers?.Authorization ? this.response(200, { token: 'registry-bearer' }) : this.response(403);
    if (pathname.endsWith('/blobs/uploads/') && method === 'POST') {
      const id = String(++this.next); this.uploads.set(id, Buffer.alloc(0));
      return this.response(202, null, { Location: `${pathname}${id}` });
    }
    const upload = pathname.match(/\/blobs\/uploads\/(\d+)$/);
    if (upload) {
      const id = upload[1], previous = this.uploads.get(id);
      if (!previous) return this.response(404);
      if (method === 'PATCH') {
        this.patchCount++; const bytes = Buffer.from(options.body);
        assert.equal(options.headers['Content-Range'], `${previous.length}-${previous.length + bytes.length - 1}`);
        const part = this.partialPatch ? bytes.subarray(0, 2) : bytes;
        const next = Buffer.concat([previous, part]); this.uploads.set(id, next);
        if (this.losePatch || this.partialPatch) { this.losePatch = false; this.partialPatch = false; throw new TypeError('uncertain response'); }
        return this.response(202, null, { Range: `0-${next.length - 1}`, Location: pathname });
      }
      if (method === 'GET') return this.response(204, null, { Range: `0-${previous.length - 1}`, Location: pathname });
      if (method === 'PUT') {
        assert.equal(url.searchParams.get('digest'), sha256(previous));
        const digest = sha256(previous); this.blobs.set(digest, previous); this.uploads.delete(id);
        if (this.loseFinalize) { this.loseFinalize = false; throw new TypeError('lost committed response'); }
        return this.response(201, null, { 'Docker-Content-Digest': digest });
      }
    }
    const blob = pathname.match(/\/blobs\/(sha256:[a-f0-9]{64})$/);
    if (blob) {
      const data = this.blobs.get(blob[1]);
      if (!data) return this.response(404);
      return this.response(200, method === 'HEAD' ? null : data.toString(), { 'Docker-Content-Digest': blob[1], 'Content-Length': String(data.length) });
    }
    const manifest = pathname.match(/\/manifests\/(.+)$/);
    if (manifest) {
      const ref = manifest[1];
      if (method === 'PUT') {
        if (ref === this.failAlias) { this.failAlias = null; return this.response(403); }
        const data = Buffer.from(options.body), digest = sha256(data);
        this.manifests.set(ref, data); this.manifests.set(digest, data);
        return this.response(201, null, { 'Docker-Content-Digest': digest });
      }
      const body = this.manifests.get(ref); if (!body) return this.response(404);
      return this.response(200, body.toString(), { 'Docker-Content-Digest': sha256(body), 'Content-Type': MEDIA.manifest });
    }
    throw new Error(`Unhandled fake route: ${method} ${pathname}`);
  }
  client() { return new Registry({ token: 'fixture-package-token', fetcher: this.fetch.bind(this), chunkSize: 4 }); }
}
test('chunked uploads verify bytes, hash and final registry roundtrip', async () => {
  const server = new FakeRegistry(); const data = Buffer.from('abcdefghijklmnop');
  const blob = await server.client().uploadStream(Readable.from([data.subarray(0, 7), data.subarray(7)]));
  assert.deepEqual(blob, { digest: sha256(data), size: data.length }); assert.equal(server.patchCount, 4);
});
test('PATCH response loss reconciles the offset without duplicate bytes', async () => {
  const server = new FakeRegistry(); server.losePatch = true;
  const data = Buffer.from('abcdefghijkl'); const descriptor = await server.client().uploadBuffer(data);
  assert.deepEqual(server.blobs.get(descriptor.digest), data); assert.equal(server.patchCount, 3);
});
test('partly accepted PATCH resumes only the remaining bytes', async () => {
  const server = new FakeRegistry(); server.partialPatch = true;
  const data = Buffer.from('abcdefgh'); const descriptor = await server.client().uploadBuffer(data);
  assert.deepEqual(server.blobs.get(descriptor.digest), data); assert.equal(server.patchCount, 3);
});
test('finalization response loss is confirmed through the blob digest', async () => {
  const server = new FakeRegistry(); server.loseFinalize = true;
  const data = Buffer.from('abcdefgh'); const descriptor = await server.client().uploadBuffer(data);
  assert.deepEqual(server.blobs.get(descriptor.digest), data);
});
test('private package verification refuses public visibility and repository association', async () => {
  const server = new FakeRegistry(); await server.client().ensurePrivate();
  server.package.visibility = 'public'; await assert.rejects(server.client().ensurePrivate(), /PACKAGE_MUST_BE_PRIVATE/);
  server.package.visibility = 'private'; server.package.repository = { full_name: 'delinoio/actions-runner-images' };
  await assert.rejects(server.client().ensurePrivate(), /PACKAGE_REPOSITORY_LINK_FORBIDDEN/);
});
test('failed multi-alias promotion restores prior manifests', async () => {
  const server = new FakeRegistry(), client = server.client();
  const old = Buffer.from(JSON.stringify({ version: 'old' })), next = Buffer.from(JSON.stringify({ version: 'new' }));
  await client.putManifest('ubuntu-24.04', old); await client.putManifest('latest', old); server.failAlias = 'latest';
  await assert.rejects(client.promote(next, 'immutable', ['ubuntu-24.04', 'latest']), /MANIFEST_WRITE_REJECTED/);
  assert.equal((await client.getManifest('ubuntu-24.04')).digest, sha256(old)); assert.equal((await client.getManifest('latest')).digest, sha256(old));
  await assert.rejects(client.promote(next, 'immutable', []), /IMMUTABLE_TAG_EXISTS/);
});
test('partial initial promotion is reported instead of claiming rollback', async () => {
  const server = new FakeRegistry(), client = server.client(); server.failAlias = 'latest';
  await assert.rejects(client.promote(Buffer.from('{}'), 'immutable', ['ubuntu-24.04', 'latest']), /PROMOTION_ROLLBACK_INCOMPLETE/);
});
