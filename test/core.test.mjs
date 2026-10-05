// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { includePath, partition, recipeFingerprint, imageConfig, SecretDetector } from '../lib/snapshot.mjs';
import { latestUbuntu, matchingRelease, shouldBuild, normalizeReport, adaptReport } from '../lib/source.mjs';
import { privatePackage, uploadURL } from '../lib/registry.mjs';
import { compareVersion } from '../lib/common.mjs';
import { retentionPlan } from '../lib/retention.mjs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

test('snapshot excludes identities and jobs while retaining tool data', () => {
  for (const file of ['/etc/shadow', '/etc/ssh/ssh_host_ed25519_key', '/home/runner/work/source/.git/config', '/home/runner/.docker/config.json', '/home/runner/.cargo/credentials.toml', '/var/lib/cloud/instance/user-data.txt', '/proc/self/environ', '/opt/actions-runner/.credentials', '/etc/apt/auth.conf.d/feed.conf', '/var/lib/ubuntu-advantage/private/machine-token.json', '/imagegeneration/ImageGeneration.log']) assert.equal(includePath(file), false, file);
  for (const file of ['/opt/hostedtoolcache/node/24/x64.complete', '/usr/local/lib/android/sdk/ndk/29/source.properties', '/home/runner/.cargo/bin/rustup', '/etc/skel/.rustup/settings.toml', '/home/linuxbrew/.linuxbrew/Homebrew/.git/HEAD', '/usr/lib/python3/work/module.py', '/home/runner/.docker/cli-plugins/docker-buildx', '/snap/chromium/1/usr/lib/chromium-browser/chrome']) assert.equal(includePath(file), true, file);
  assert.equal(includePath('/usr/local/repository', ['/usr/local/repository']), false);
  assert.equal(includePath('/home/runner/.dotnet/corefx/cryptography/x509stores/my/certificate.pfx'), false);
  assert.equal(includePath('/etc/skel/.dotnet/corefx/cryptography/x509stores/my/certificate.pfx'), false);
  assert.equal(includePath('/home/runner/.local/share/pki/private.key'), false);
  assert.throws(() => includePath('/usr/../etc/shadow'));
});
test('hard links stay together and oversized files fail', () => {
  const entries = [{ path: '/', directory: true, size: 0 }, { path: '/a', size: 100, links: 2, inode: '1' }, { path: '/b', size: 100, links: 2, inode: '1' }, { path: '/c', size: 200, links: 1 }];
  const layers = partition(entries, 10_000);
  assert.equal(layers.length, 3); assert.deepEqual(layers[1].files, ['./a', './b']);
  assert.throws(() => partition([{ path: '/a', size: 100_000 }], 10_000), /FILE_EXCEEDS_LAYER_BUDGET/);
});
test('secret scanning detects values split across tar chunks', async () => {
  await assert.rejects(pipeline(Readable.from(['before super-', 'secret-token after']), new SecretDetector(['super-secret-token']), async stream => { for await (const ignored of stream) {} }), /CREDENTIAL_IN_SNAPSHOT/);
});
test('recipe hash is ordered and changes on a recipe change', () => {
  assert.equal(recipeFingerprint([['b', '2'], ['a', '1']]), recipeFingerprint([['a', '1'], ['b', '2']]));
  assert.notEqual(recipeFingerprint([['a', '1']]), recipeFingerprint([['a', '2']]));
});
test('image config has runner identity and no private job environment or volumes', () => {
  const config = imageConfig(['PATH=/usr/bin', 'HOME=/home/runner'], [{ diff_id: 'sha256:a' }], { imageOS: 'ubuntu24', imageVersion: '20260927.320.1', recipeRevision: 'a', sourceRevision: 'b', inventoryHash: 'c' });
  assert.equal(config.config.User, 'runner'); assert.equal(config.config.Volumes, undefined); assert.equal(config.config.Labels['org.opencontainers.image.source'], undefined);
  assert.throws(() => imageConfig(['GITHUB_TOKEN=x'], [], {}));
});
test('latest mapping follows the documented x64 row and rejects unknown versions', () => {
  assert.equal(latestUbuntu('| Ubuntu 24.04 | x64 | `ubuntu-latest` or `ubuntu-24.04` |\n| Ubuntu 26.04 | x64 | `ubuntu-26.04` |'), '24.04');
  assert.equal(latestUbuntu('| Ubuntu 26.04 | x64 | `ubuntu-latest` or `ubuntu-26.04` |'), '26.04');
  assert.throws(() => latestUbuntu('| Ubuntu 28.04 | x64 | `ubuntu-latest` or `ubuntu-28.04` |'));
});
test('stable source matching excludes prereleases and version downgrades', () => {
  const release = { tag_name: 'ubuntu24/20260927.320', draft: false, prerelease: false };
  assert.equal(matchingRelease([{ ...release, prerelease: true }, release], '24.04', '20260927.320.1'), release);
  const previous = { published: { imageVersion: '20260927.320.1', recipeHash: 'a' } };
  assert.equal(shouldBuild(previous, '20260927.320.1', 'a'), false);
  assert.equal(shouldBuild(previous, '20260927.320.1', 'b'), true);
  assert.throws(() => shouldBuild(previous, '20260920.300.1', 'b', true), /HOST_VERSION_DOWNGRADE/);
  assert.equal(compareVersion('20260927.9.1', '20260927.10.1'), -1);
});
test('report normalization preserves versions and table column meaning', () => {
  const make = row => ({ NodeType: 'HeaderNode', Children: [{ NodeType: 'TableNode', Headers: ['Name', 'Version'], Rows: [row] }] });
  assert.notDeepEqual(normalizeReport(make(['Java', '17'])), normalizeReport(make(['17', 'Java'])));
  assert.throws(() => normalizeReport({}), /REPORT_SCHEMA_CHANGED/);
});
test('APT report retains multi-version values in one table cell and rejects changed probes', () => {
  const input = "$version = $version -replace '~','\\~'";
  const adapted = adaptReport('SoftwareReport.Common.psm1', input);
  assert.equal(adapted, "$version = (@($version) -join ', ') -replace '~','\\~'");
  assert.throws(() => adaptReport('SoftwareReport.Common.psm1', 'changed'), /UPSTREAM_APT_VERSION_PROBE_CHANGED/);
});
test('private package and upload origins fail closed', () => {
  const metadata = { name: 'actions-runner-images', package_type: 'container', visibility: 'private' };
  privatePackage(metadata);
  assert.throws(() => privatePackage({ ...metadata, visibility: 'public' }));
  assert.throws(() => privatePackage({ ...metadata, repository: { full_name: 'delinoio/actions-runner-images' } }));
  assert.equal(uploadURL('/v2/delinoio/actions-runner-images/blobs/uploads/1').hostname, 'ghcr.io');
  assert.equal(uploadURL('/v2/delinoio/actions-runner-images/blobs/upload/1').hostname, 'ghcr.io');
  assert.throws(() => uploadURL('https://other.example/v2/delinoio/actions-runner-images/blobs/uploads/1'));
  assert.throws(() => uploadURL('/v2/delinoio/unrelated/blobs/uploads/1'));
});
test('retention keeps four per OS including current aliases and ignores unrelated tags', () => {
  const versions = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `digest${i}`, created_at: `2026-10-0${6 - i}T00:00:00Z`, metadata: { container: { tags: [`ubuntu24-2026100${6 - i}.1.1-aaaaaaaaaaaa-${i + 1}-1`] } } }));
  versions.push({ id: 100, name: 'other', metadata: { container: { tags: ['manual'] } } });
  assert.deepEqual(retentionPlan(versions, new Set(['digest0'])), [5, 6]);
});
