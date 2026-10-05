// SPDX-License-Identifier: Apache-2.0
import { statfs, rm, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { normalizeReport } from '../lib/source.mjs';
import { Registry } from '../lib/registry.mjs';
import { requireHosted, readJSON, jsonFile, command, invariant, reportFailure, log, childEnvironment, IMAGE } from '../lib/common.mjs';
const os = process.argv[2];
const root = path.resolve('.work/verification');
let daemon, daemonExited;
try {
  requireHosted(os); invariant(process.getuid() === 0, 'ROOT_VERIFICATION_REQUIRED');
  const candidate = await readJSON('.work/candidate.json');
  await mkdir('.work/control', { recursive: true });
  await cp(process.execPath, '.work/control/node');
  // Reclaim only exported software on this disposable VM, never on a user CI machine.
  const reclaim = ['/opt/hostedtoolcache', '/usr/local/lib/android', '/usr/share/dotnet', '/usr/share/swift', '/usr/share/miniconda', '/usr/local/.ghcup', '/usr/local/share/powershell', '/usr/lib/jvm', '/usr/lib/llvm-16', '/usr/lib/llvm-17', '/usr/lib/llvm-18', '/usr/lib/llvm-19', '/usr/lib/llvm-20', '/usr/lib/llvm-21', '/usr/lib/llvm-22', '/usr/lib/google-cloud-sdk', '/home/linuxbrew', '/etc/skel/.rustup', '/etc/skel/.cargo', '/etc/skel/.dotnet', '/home/runner/.rustup', '/home/runner/.cargo', '/home/runner/.dotnet'];
  for (const directory of reclaim) await rm(directory, { recursive: true, force: true });
  await mkdir(root, { recursive: true }); const disk = await statfs(root);
  const available = disk.bavail * disk.bsize;
  log('verification_storage', { available, required: Math.ceil(candidate.uncompressed * 1.1 + 2 * 1024 ** 3) });
  invariant(available > candidate.uncompressed * 1.1 + 2 * 1024 ** 3, 'VERIFICATION_DISK_INSUFFICIENT');
  const configPath = path.join(root, 'daemon.json'), socket = path.join(root, 'docker.sock');
  await jsonFile(configPath, { 'data-root': path.join(root, 'data'), 'exec-root': path.join(root, 'exec'), 'pidfile': path.join(root, 'daemon.pid'), hosts: [`unix://${socket}`], 'storage-driver': 'overlay2', features: { 'containerd-snapshotter': false }, iptables: false, 'ip-masq': false, 'ip-forward': false, bridge: 'none' });
  const env = { ...childEnvironment(), DOCKER_HOST: `unix://${socket}`, DOCKER_CONFIG: path.join(root, 'auth') };
  delete env.DOCKER_CONTEXT;
  daemon = spawn('/usr/bin/dockerd', ['--config-file', configPath], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  daemonExited = new Promise(resolve => { daemon.once('error', resolve); daemon.once('exit', resolve); });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await command('/usr/bin/docker', ['info'], { env }); ready = true; break; } catch { if (daemon.exitCode !== null) break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  invariant(ready, 'VERIFICATION_DAEMON_UNAVAILABLE');
  const token = process.env.GHCR_PUBLISH_TOKEN; invariant(token, 'REGISTRY_CREDENTIAL_REQUIRED');
  await command('/usr/bin/docker', ['login', 'ghcr.io', '--username', process.env.GHCR_USERNAME ?? 'kdy1', '--password-stdin'], { env, input: token });
  const image = `${IMAGE}@${candidate.digest}`;
  await command('/usr/bin/docker', ['pull', '--platform', 'linux/amd64', image], { env });
  const inspected = JSON.parse(await command('/usr/bin/docker', ['image', 'inspect', image], { env }))[0];
  invariant(inspected.Os === 'linux' && inspected.Architecture === 'amd64' && inspected.Config.User === 'runner' && !Object.keys(inspected.Config.Volumes ?? {}).length, 'RUNMOOR_IMAGE_CONFIG_MISMATCH');
  const output = path.join(root, 'output'); await mkdir(output, { recursive: true });
  await command('chown', ['1001:1001', output]);
  const sandbox = ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'runner', '--mount', `type=bind,src=${output},dst=/verification-output`, '--entrypoint', 'pwsh', image];
  await command('/usr/bin/docker', [...sandbox, '-NoLogo', '-NoProfile', '-File', '/usr/local/share/runmoor-image/reporter/docs-gen/Generate-SoftwareReport.ps1', '-OutputDirectory', '/verification-output'], { env });
  const expected = await readJSON('.work/inventory.json');
  const actual = normalizeReport(await readJSON(path.join(output, 'software-report.json')));
  invariant(JSON.stringify(expected.report) === JSON.stringify(actual), 'SOFTWARE_INVENTORY_MISMATCH');
  const packages = await command('/usr/bin/docker', ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'dpkg-query', image, '-W', '-f=${binary:Package}\t${Version}\n'], { env });
  invariant(JSON.stringify(expected.aptPackages) === JSON.stringify(packages.trim().split('\n').sort()), 'APT_INVENTORY_MISMATCH');
  const smoke = await readFile('scripts/smoke.sh');
  await command('/usr/bin/docker', ['run', '--rm', '-i', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'runner', '--entrypoint', '/bin/bash', image], { env, input: smoke });
  await jsonFile('.work/verified.json', { digest: candidate.digest, verifiedAt: new Date().toISOString(), softwareInventory: 'passed', aptInventory: 'passed', sandboxCompilation: 'passed' });
  log('candidate_verified', { os, digest: candidate.digest });
} catch (error) { reportFailure(error); process.exitCode = 1; }
finally {
  if (daemon) {
    daemon.kill('SIGTERM');
    await Promise.race([daemonExited, new Promise(resolve => setTimeout(resolve, 10_000))]);
    if (daemon.exitCode === null) { daemon.kill('SIGKILL'); await daemonExited; }
  }
  await rm(path.join(root, 'auth'), { recursive: true, force: true });
}
