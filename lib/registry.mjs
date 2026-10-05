// SPDX-License-Identifier: Apache-2.0
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Failure, invariant, sha256, PACKAGE, log } from './common.mjs';
import { GitHub } from './github.mjs';

export const MEDIA = Object.freeze({ manifest: 'application/vnd.oci.image.manifest.v1+json', config: 'application/vnd.oci.image.config.v1+json', layer: 'application/vnd.oci.image.layer.v1.tar+gzip' });
const REF = /^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})$/;
export function privatePackage(metadata) {
  invariant(metadata.name === PACKAGE && metadata.package_type === 'container', 'WRONG_PACKAGE');
  invariant(metadata.visibility === 'private', 'PACKAGE_MUST_BE_PRIVATE');
  invariant(!metadata.repository, 'PACKAGE_REPOSITORY_LINK_FORBIDDEN');
}
export function uploadURL(location, base = 'https://ghcr.io') {
  const url = new URL(location, base);
  invariant(url.origin === 'https://ghcr.io' && !url.username && !url.password && !url.hash, 'UNTRUSTED_UPLOAD_ORIGIN');
  // GHCR may return a singular upload route in Location even though POST uses uploads/.
  const prefix = `/v2/delinoio/${PACKAGE}/blobs/`;
  if (!(url.pathname.startsWith(`${prefix}uploads/`) || url.pathname.startsWith(`${prefix}upload/`))) {
    const known = new Set(['v2', 'v1', 'delinoio', PACKAGE, 'blobs', 'blob', 'uploads', 'upload', 'docker']);
    log('unexpected_upload_route', { shape: url.pathname.split('/').filter(Boolean).map(part => known.has(part) ? part : '<opaque>') });
    throw new Failure('UNTRUSTED_UPLOAD_PATH');
  }
  return url;
}
export function receivedOffset(response) {
  const range = response.headers.get('Range');
  invariant(range && /^0-\d+$/.test(range), 'INVALID_UPLOAD_RANGE');
  return Number(range.slice(2)) + 1;
}
export function retryableUpload(error) {
  return error.code === 'REGISTRY_REQUEST_FAILED' || (error.code === 'UPLOAD_PATCH_REJECTED' && (error.status === 401 || error.status === 429 || error.status >= 500));
}

export class Registry {
  constructor({ token = process.env.GHCR_PUBLISH_TOKEN, username = process.env.GHCR_USERNAME ?? 'kdy1', fetcher = fetch, chunkSize = 8 * 1024 * 1024, verificationDelay = 1000 } = {}) {
    invariant(token && /^[a-zA-Z0-9-]+$/.test(username), 'REGISTRY_CREDENTIAL_REQUIRED');
    this.token = token; this.username = username; this.fetcher = fetcher; this.chunkSize = chunkSize;
    this.verificationDelay = verificationDelay;
    this.github = new GitHub(token, fetcher);
  }
  async bearer(force = false) {
    if (!force && this.registryToken && Date.now() < this.expires) return this.registryToken;
    let response;
    try {
      response = await this.fetcher(`https://ghcr.io/token?service=ghcr.io&scope=repository:delinoio/${PACKAGE}:pull,push`, {
        headers: { Authorization: `Basic ${Buffer.from(`${this.username}:${this.token}`).toString('base64')}` },
        redirect: 'error', signal: AbortSignal.timeout(60_000),
      });
    } catch { throw new Failure('REGISTRY_AUTH_REQUEST_FAILED'); }
    invariant(response.ok, 'REGISTRY_AUTH_REJECTED');
    const body = await response.json(); invariant(typeof body.token === 'string', 'REGISTRY_TOKEN_MISSING');
    this.registryToken = body.token; this.expires = Date.now() + Math.min(180, body.expires_in ?? 180) * 1000 - 10_000;
    return body.token;
  }
  async request(path, options = {}) {
    const { timeout = 60_000, retryAuth = true, blobRedirect = false, ...fetchOptions } = options;
    const url = path instanceof URL ? path : new URL(`https://ghcr.io/v2/delinoio/${PACKAGE}/${path}`);
    invariant(url.origin === 'https://ghcr.io' && url.pathname.startsWith(`/v2/delinoio/${PACKAGE}/`), 'REGISTRY_PATH_REJECTED');
    invariant(!blobRedirect || ((fetchOptions.method ?? 'GET') === 'GET' && url.pathname.startsWith(`/v2/delinoio/${PACKAGE}/blobs/sha256:`)), 'BLOB_REDIRECT_SCOPE_REJECTED');
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try { response = await this.fetcher(url, { ...fetchOptions, headers: { ...fetchOptions.headers, Authorization: `Bearer ${await this.bearer(attempt > 0)}` }, redirect: blobRedirect ? 'manual' : 'error', signal: AbortSignal.timeout(timeout) }); }
      catch { throw new Failure('REGISTRY_REQUEST_FAILED'); }
      if (response.status !== 401 || attempt === 1 || !retryAuth) return response;
    }
  }
  async validateCredential() {
    const response = await this.github.request('/user');
    invariant(response.ok, 'PACKAGE_PAT_REJECTED');
    const scopes = new Set((response.headers.get('X-OAuth-Scopes') ?? '').split(',').map(value => value.trim()).filter(Boolean));
    invariant(scopes.has('write:packages') && scopes.has('delete:packages'), 'PACKAGE_PAT_SCOPES_REQUIRED');
    invariant(![...scopes].some(scope => scope === 'repo' || scope === 'public_repo' || scope.startsWith('repo:')), 'REPOSITORY_PAT_SCOPE_FORBIDDEN');
    invariant((await response.json()).login === this.username, 'PUBLISHER_IDENTITY_MISMATCH');
  }
  async ensurePrivate() {
    await this.validateCredential();
    const path = `/orgs/delinoio/packages/container/${PACKAGE}`;
    let response = await this.github.request(path);
    if (response.status === 404) {
      // An empty rootfs establishes the package before any licensed software is uploaded.
      const config = await this.uploadBuffer(Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [] } })));
      const manifest = { schemaVersion: 2, mediaType: MEDIA.manifest, config: { mediaType: MEDIA.config, ...config }, layers: [] };
      await this.putManifest('bootstrap-private', Buffer.from(JSON.stringify(manifest)));
      for (let i = 0; i < 5; i++) {
        response = await this.github.request(path);
        if (response.status !== 404) break;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    invariant(response.ok, 'PACKAGE_PRIVACY_UNVERIFIED'); privatePackage(await response.json());
    let anonymous;
    try {
      anonymous = await this.fetcher(`https://ghcr.io/token?service=ghcr.io&scope=repository:delinoio/${PACKAGE}:pull`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (anonymous.ok) {
        const bearer = (await anonymous.json()).token;
        invariant(typeof bearer === 'string', 'ANONYMOUS_AUTH_UNVERIFIED');
        anonymous = await this.fetcher(`https://ghcr.io/v2/delinoio/${PACKAGE}/tags/list`, { headers: { Authorization: `Bearer ${bearer}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      }
    } catch (error) { if (error.code) throw error; throw new Failure('ANONYMOUS_ACCESS_CHECK_FAILED'); }
    invariant(anonymous.status === 401 || anonymous.status === 403 || anonymous.status === 404, 'ANONYMOUS_PACKAGE_ACCESS_FORBIDDEN');
    log('package_privacy_verified');
  }
  async verifyBlob(digest, size) {
    invariant(/^sha256:[a-f0-9]{64}$/.test(digest) && Number.isSafeInteger(size), 'INVALID_BLOB_DESCRIPTOR');
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const head = await this.request(`blobs/${digest}`, { method: 'HEAD', headers: { 'Cache-Control': 'no-cache' }, timeout: 15_000 });
        const digestMatches = head.headers.get('Docker-Content-Digest') === digest;
        const length = head.headers.get('Content-Length'), receivedSize = length !== null && /^\d+$/.test(length) ? Number(length) : null;
        if (head.ok && digestMatches && receivedSize === size) return;
        log('blob_roundtrip_pending', { attempt: attempt + 1, status: head.status, digestMatches, receivedSize, expectedSize: size });
      } catch (error) { log('blob_roundtrip_pending', { attempt: attempt + 1, code: error.code ?? 'REGISTRY_REQUEST_FAILED', expectedSize: size }); }
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, Math.min(8000, this.verificationDelay * 2 ** attempt)));
    }
    throw new Failure('BLOB_ROUNDTRIP_MISMATCH');
  }
  async uploadStream(stream) {
    const response = await this.request('blobs/uploads/', { method: 'POST', body: '' });
    invariant(response.status === 202, 'UPLOAD_START_REJECTED');
    let location = uploadURL(response.headers.get('Location'));
    const hash = createHash('sha256'); let size = 0;
    const body = Readable.from((async function* () {
      for await (const part of stream) {
        const chunk = Buffer.from(part); size += chunk.length;
        invariant(size < 10_000_000_000, 'GHCR_LAYER_LIMIT'); hash.update(chunk); yield chunk;
      }
    })());
    // GHCR rejects multi-PATCH uploads. A single chunked HTTP body preserves
    // bounded memory and streaming compression without staging the layer.
    let patched;
    try {
      patched = await this.request(location, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body, duplex: 'half', timeout: 9 * 60_000, retryAuth: false });
    } catch (error) { body.destroy(); throw error; }
    if (patched.status !== 202) { body.destroy(); throw new Failure('UPLOAD_PATCH_REJECTED', patched.status); }
    const offset = receivedOffset(patched);
    if (!body.readableEnded || offset !== size) {
      log('upload_offset_mismatch', { ended: body.readableEnded, expectedSize: size, receivedSize: offset });
      throw new Failure('UPLOAD_OFFSET_MISMATCH');
    }
    location = uploadURL(patched.headers.get('Location'));
    const digest = `sha256:${hash.digest('hex')}`; const url = new URL(location); url.searchParams.set('digest', digest);
    let finalized = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const final = await this.request(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' }, body: '' });
        if (final.status === 201) { invariant(final.headers.get('Docker-Content-Digest') === digest, 'FINAL_DIGEST_MISMATCH'); finalized = true; break; }
        if (final.status < 500 && final.status !== 404 && final.status !== 429) throw new Failure('UPLOAD_FINALIZE_REJECTED', final.status);
      } catch (error) { if (error.code && error.code !== 'REGISTRY_REQUEST_FAILED') throw error; }
      // A committed upload may disappear before its successful response reaches us.
      try { await this.verifyBlob(digest, size); finalized = true; break; } catch { /* Retry finalization only after checking the digest. */ }
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
    invariant(finalized, 'UPLOAD_FINALIZE_UNCONFIRMED'); await this.verifyBlob(digest, size);
    return { digest, size };
  }
  async uploadBuffer(buffer) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await this.uploadStream(Readable.from([buffer])); }
      catch (error) {
        if (!retryableUpload(error) || attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
  async getManifest(ref) {
    invariant(REF.test(ref), 'INVALID_IMAGE_REFERENCE');
    const response = await this.request(`manifests/${ref}`, { headers: { Accept: MEDIA.manifest } });
    if (response.status === 404) return null;
    invariant(response.ok, 'MANIFEST_READ_REJECTED');
    const body = Buffer.from(await response.arrayBuffer()), digest = sha256(body);
    invariant(response.headers.get('Docker-Content-Digest') === digest, 'MANIFEST_DIGEST_MISMATCH');
    return { body, digest, manifest: JSON.parse(body) };
  }
  async getConfig(descriptor) {
    invariant(descriptor.mediaType === MEDIA.config && /^sha256:[a-f0-9]{64}$/.test(descriptor.digest) && Number.isSafeInteger(descriptor.size) && descriptor.size > 0 && descriptor.size <= 2 * 1024 * 1024, 'INVALID_CONFIG_DESCRIPTOR');
    let response = await this.request(`blobs/${descriptor.digest}`, { blobRedirect: true });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = new URL(response.headers.get('Location') ?? '', 'https://ghcr.io');
      invariant(location.origin === 'https://pkg-containers.githubusercontent.com' && !location.username && !location.password && !location.hash, 'UNTRUSTED_CONFIG_DOWNLOAD_ORIGIN');
      // GHCR redirects blob reads to its signed CDN URL. Never send the registry
      // bearer/PAT to that origin, and reject any further redirect. Keep this
      // exception limited to small configuration blobs with known digests.
      log('registry_config_redirect', { origin: 'github-container-cdn' });
      try { response = await this.fetcher(location, { redirect: 'error', signal: AbortSignal.timeout(60_000) }); }
      catch { throw new Failure('CONFIG_DOWNLOAD_FAILED'); }
    }
    invariant(response.ok && response.body, 'CONFIG_READ_REJECTED');
    const chunks = []; let size = 0;
    for await (const part of response.body) {
      size += part.byteLength; invariant(size <= descriptor.size, 'CONFIG_DOWNLOAD_TOO_LARGE'); chunks.push(Buffer.from(part));
    }
    const body = Buffer.concat(chunks);
    invariant(size === descriptor.size && sha256(body) === descriptor.digest, 'CONFIG_DIGEST_MISMATCH');
    try { return JSON.parse(body); } catch { throw new Failure('CONFIG_JSON_INVALID'); }
  }
  async putManifest(ref, body) {
    invariant(REF.test(ref), 'INVALID_IMAGE_REFERENCE');
    const digest = sha256(body);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await this.request(`manifests/${ref}`, { method: 'PUT', headers: { 'Content-Type': MEDIA.manifest }, body });
        if (response.status === 201) { invariant(response.headers.get('Docker-Content-Digest') === digest, 'MANIFEST_WRITE_DIGEST_MISMATCH'); break; }
        if (response.status < 500 && response.status !== 429) throw new Failure('MANIFEST_WRITE_REJECTED', response.status);
      } catch (error) { if (error.code && error.code !== 'REGISTRY_REQUEST_FAILED') throw error; }
      const current = await this.getManifest(ref); if (current?.digest === digest) return digest;
      if (attempt === 3) throw new Failure('MANIFEST_WRITE_UNCONFIRMED');
    }
    invariant((await this.getManifest(ref))?.digest === digest, 'MANIFEST_ROUNDTRIP_MISMATCH'); return digest;
  }
  async promote(body, immutable, aliases) {
    invariant(!(await this.getManifest(immutable)), 'IMMUTABLE_TAG_EXISTS');
    const previous = new Map(); for (const alias of aliases) previous.set(alias, await this.getManifest(alias));
    await this.putManifest(immutable, body);
    const changed = [];
    try { for (const alias of aliases) { changed.push(alias); await this.putManifest(alias, body); } }
    catch (error) {
      let incomplete = false;
      for (const alias of changed.reverse()) {
        if (!previous.get(alias)) { incomplete = true; continue; }
        try { await this.putManifest(alias, previous.get(alias).body); } catch { incomplete = true; }
      }
      if (incomplete) throw new Failure('PROMOTION_ROLLBACK_INCOMPLETE');
      throw error;
    }
    return sha256(body);
  }
  async versions() {
    const all = [];
    for (let page = 1; ; page++) {
      const versions = await this.github.json(`/orgs/delinoio/packages/container/${PACKAGE}/versions?per_page=100&page=${page}`);
      all.push(...versions); if (versions.length < 100) return all;
    }
  }
  async deleteVersion(id) {
    invariant(Number.isSafeInteger(id) && id > 0, 'INVALID_PACKAGE_VERSION');
    await this.github.json(`/orgs/delinoio/packages/container/${PACKAGE}/versions/${id}`, { method: 'DELETE' });
  }
}
