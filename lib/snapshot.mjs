// SPDX-License-Identifier: Apache-2.0
import { lstat, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { invariant, Failure, childEnvironment, log, sha256 } from './common.mjs';
import { MEDIA } from './registry.mjs';

const EXCLUDED = [
  '/proc', '/sys', '/dev', '/run', '/tmp', '/mnt', '/media', '/boot', '/lost+found', '/data', '/swapfile', '/swap.img',
  '/opt/actions-runner', '/opt/runner', '/opt/runmoor-runner',
  '/var/cache', '/var/log', '/var/tmp', '/var/crash', '/var/backups', '/var/spool',
  '/var/lib/docker', '/var/lib/containerd', '/var/lib/containers', '/var/lib/cloud', '/var/lib/waagent',
  '/var/lib/amazon', '/var/lib/azure', '/var/lib/dhcp', '/var/lib/systemd', '/var/lib/private', '/var/lib/apt/lists',
  '/var/lib/snapd', '/var/snap',
  '/etc/shadow', '/etc/shadow-', '/etc/gshadow', '/etc/gshadow-', '/etc/machine-id', '/etc/hostname',
  '/etc/hosts', '/etc/resolv.conf', '/etc/fstab', '/etc/crypttab', '/etc/cloud', '/etc/waagent.conf',
  '/etc/azure', '/etc/netplan', '/etc/NetworkManager/system-connections', '/etc/ssl/private', '/etc/letsencrypt',
];
const HOME_TOOLS = [
  '.cargo', '.rustup', '.dotnet', '.nuget', '.ghcup', '.nvm', '.vcpkg', '.local',
  '.config/powershell', '.docker/cli-plugins', '.cache/ms-playwright', '.cache/selenium',
];
const HOME_FILES = ['.profile', '.bashrc', '.bash_profile', '.zshrc'];
export function within(value, prefix) { return value === prefix || value.startsWith(`${prefix}/`); }
export function includePath(value, extraExclusions = []) {
  invariant(value.startsWith('/') && path.posix.normalize(value) === value && !value.includes('\0') && !value.includes('\ufffd'), 'INVALID_SNAPSHOT_PATH');
  if ([...EXCLUDED, ...extraExclusions].some(prefix => within(value, prefix))) return false;
  if (/(?:^|\/)(?:\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.env(?:\..*)?|keyrings?)(?:\/|$)/i.test(value)) return false;
  if (/\/\.git(?:\/|$)/.test(value) && !['/usr', '/opt', '/home/linuxbrew'].some(prefix => within(value, prefix))) return false;
  if (/^\/(?:root|home\/runner)\/\.cargo\/credentials(?:\.|$)/.test(value)) return false;
  if (/^\/etc\/ssh\/ssh_host_/.test(value) || /\/\.docker\/(?:config\.json|contexts)(?:\/|$)/.test(value)) return false;
  if (value.startsWith('/imagegeneration/') && /\.(?:tar(?:\.\w+)?|zip|deb|rpm)$/.test(value)) return false;
  if (value === '/root' || value === '/home' || value === '/home/runner' || value === '/home/linuxbrew') return true;
  if (within(value, '/home/linuxbrew')) return !within(value, '/home/linuxbrew/.cache');
  for (const home of ['/home/runner', '/root']) {
    if (within(value, home)) {
      const relative = value.slice(home.length + 1);
      return HOME_FILES.includes(relative) || HOME_TOOLS.some(prefix => within(relative, prefix) || within(prefix, relative));
    }
  }
  if (value.startsWith('/home/')) return false;
  return true;
}
export async function enumerate(root = '/', extraExclusions = []) {
  const entries = [];
  async function walk(relative) {
    const absolute = relative === '/' ? root : path.join(root, relative.slice(1));
    const stat = await lstat(absolute);
    if (!includePath(relative, extraExclusions)) return;
    if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) return;
    entries.push({ path: relative, size: stat.isFile() ? stat.size : 0, directory: stat.isDirectory(), inode: `${stat.dev}:${stat.ino}`, links: stat.nlink, uid: stat.uid, gid: stat.gid, mode: stat.mode });
    if (stat.isDirectory()) for (const name of (await readdir(absolute)).sort()) await walk(relative === '/' ? `/${name}` : `${relative}/${name}`);
  }
  await walk('/'); return entries;
}
export function partition(entries, limit = 2 * 1024 ** 3) {
  const units = [], links = new Map();
  // Directory metadata comes first. Keep all members of a hard-link group in one tar invocation.
  for (const entry of entries.filter(item => item.directory)) units.push([entry]);
  for (const entry of entries.filter(item => !item.directory)) {
    if (entry.links > 1 && entry.size > 0) {
      if (!links.has(entry.inode)) { const unit = []; links.set(entry.inode, unit); units.push(unit); }
      links.get(entry.inode).push(entry);
    } else units.push([entry]);
  }
  const layers = []; let files = [], bytes = 0;
  for (const unit of units) {
    const size = Math.ceil(Math.max(...unit.map(item => item.size)) / 512) * 512 + unit.length * 4096;
    invariant(size <= limit, 'FILE_EXCEEDS_LAYER_BUDGET');
    if (files.length && bytes + size > limit) { layers.push({ files, bytes }); files = []; bytes = 0; }
    files.push(...unit.map(item => item.path === '/' ? '.' : `.${item.path}`)); bytes += size;
  }
  if (files.length) layers.push({ files, bytes });
  invariant(layers.length > 0 && layers.length <= 120, 'UNSUPPORTED_LAYER_COUNT'); return layers;
}
export class SecretDetector extends Transform {
  constructor(values) { super(); this.values = [...new Set(values.filter(value => typeof value === 'string' && value.length >= 12))].map(value => Buffer.from(value)); this.tail = Buffer.alloc(0); this.overlap = Math.max(0, ...this.values.map(value => value.length - 1)); }
  _transform(chunk, encoding, callback) {
    const data = Buffer.concat([this.tail, chunk]);
    if (this.values.some(value => data.includes(value))) return callback(new Failure('CREDENTIAL_IN_SNAPSHOT'));
    this.tail = data.subarray(Math.max(0, data.length - this.overlap)); callback(null, chunk);
  }
}
export async function exportLayer(registry, root, layer, work, index, secrets = []) {
  await mkdir(work, { recursive: true }); const list = path.join(work, `layer-${index}.files`);
  await writeFile(list, `${layer.files.join('\0')}\0`);
  const tar = spawn(process.env.TAR ?? 'tar', ['--create', '--format=pax', '--numeric-owner', '--acls', '--xattrs', '--sparse', '--no-recursion', '--directory', root, '--null', '--verbatim-files-from', '--files-from', list], { env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  tar.stderr.resume();
  const exited = new Promise((resolve, reject) => {
    tar.once('error', () => reject(new Failure('TAR_START_FAILED')));
    tar.once('exit', code => code === 0 ? resolve() : reject(new Failure('SNAPSHOT_READ_FAILED')));
  });
  // Attach a handler immediately; tar can fail before the upload awaits its completion.
  exited.catch(() => {});
  const hash = createHash('sha256'); let uncompressed = 0;
  const hashing = new Transform({ transform(chunk, encoding, callback) { uncompressed += chunk.length; hash.update(chunk); callback(null, chunk); } });
  const gzip = createGzip({ level: 6 });
  const producing = pipeline(tar.stdout, new SecretDetector(secrets), hashing, gzip);
  producing.catch(() => {});
  try {
    const uploaded = await registry.uploadStream(gzip); await producing; await exited;
    const diff_id = `sha256:${hash.digest('hex')}`;
    log('layer_uploaded', { index, bytes: uploaded.size, uncompressed });
    return { mediaType: MEDIA.layer, ...uploaded, diff_id, uncompressed };
  } catch (error) { tar.kill('SIGTERM'); gzip.destroy(); await Promise.allSettled([producing, exited]); throw error; }
}

export async function staticEnvironment(file = '/etc/environment') {
  const values = new Map();
  const allowed = /^(?:PATH|LANG|LC_ALL|JAVA_HOME(?:_\d+_X64)?|ANDROID_HOME|ANDROID_SDK_ROOT|ANDROID_NDK(?:_HOME|_ROOT|_LATEST_HOME)?|NDK_HOME|CHROMEWEBDRIVER|EDGEWEBDRIVER|GECKOWEBDRIVER|SELENIUM_JAR_PATH|GOROOT(?:_\d+_\d+_X64)?|CONDA|VCPKG_INSTALLATION_ROOT|BOOST_ROOT(?:_\d+_\d+_\d+)?|CHROME_BIN|CHROMIUM_BIN|HELPER_SCRIPTS|INSTALLER_SCRIPT_FOLDER|DEBIAN_FRONTEND|GRADLE_HOME|HOMEBREW_PREFIX|HOMEBREW_CELLAR|HOMEBREW_REPOSITORY)$/;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/); invariant(match, 'UNRECOGNIZED_STATIC_ENVIRONMENT');
    if (!allowed.test(match[1])) continue;
    let value = match[2].trim(); if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    invariant(!/[\n\r\0`$]/.test(value), 'DYNAMIC_STATIC_ENVIRONMENT'); values.set(match[1], value);
  }
  // Read only documented tool defaults; never serialize the complete job environment.
  for (const [key, value] of Object.entries(process.env)) {
    if (!allowed.test(key)) continue;
    invariant(!/[\n\r\0`$]/.test(value), 'DYNAMIC_TOOL_ENVIRONMENT');
    invariant(![process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP].filter(Boolean).some(prefix => value.includes(prefix)), 'JOB_PATH_IN_TOOL_ENVIRONMENT');
    values.set(key, value);
  }
  values.set('HOME', '/home/runner'); values.set('USER', 'runner'); values.set('LOGNAME', 'runner');
  values.set('AGENT_TOOLSDIRECTORY', '/opt/hostedtoolcache'); values.set('RUNNER_TOOL_CACHE', '/opt/hostedtoolcache');
  invariant(values.has('PATH'), 'STATIC_PATH_REQUIRED'); return [...values].map(([key, value]) => `${key}=${value}`);
}
export function imageConfig(environment, layers, provenance) {
  invariant(!environment.some(value => /^(?:GITHUB_|ACTIONS_|.*TOKEN|.*SECRET|.*PASSWORD)/.test(value)), 'PRIVATE_IMAGE_ENVIRONMENT');
  return {
    created: new Date().toISOString(), architecture: 'amd64', os: 'linux',
    config: { User: 'runner', WorkingDir: '/home/runner', Env: [...environment, `ImageOS=${provenance.imageOS}`, `ImageVersion=${provenance.imageVersion}`, `IMAGE_VERSION=${provenance.imageVersion}`], Cmd: ['/bin/bash'], Labels: { 'org.opencontainers.image.revision': provenance.recipeRevision, 'io.delino.runner-images.source-revision': provenance.sourceRevision, 'io.delino.runner-images.inventory-sha256': provenance.inventoryHash } },
    rootfs: { type: 'layers', diff_ids: layers.map(layer => layer.diff_id) },
    history: [{ created: new Date().toISOString(), created_by: 'Reviewed GitHub-hosted Ubuntu software snapshot', empty_layer: true }],
  };
}
export function recipeFingerprint(files) {
  const hash = createHash('sha256');
  for (const [name, body] of [...files].sort(([a], [b]) => a.localeCompare(b))) { hash.update(name); hash.update('\0'); hash.update(body); hash.update('\0'); }
  return hash.digest('hex');
}
