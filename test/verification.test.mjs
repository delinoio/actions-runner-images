// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { verificationRoot, daemonConfig, daemonReason } from '../lib/verification.mjs';
import { jsonFile, command, childEnvironment } from '../lib/common.mjs';

test('daemon diagnostics expose closed reasons instead of raw stderr', () => {
  assert.equal(daemonReason('bind: invalid argument'), 'socket-path');
  assert.equal(daemonReason('operation not permitted'), 'permissions');
  assert.equal(daemonReason('arbitrary host details'), 'unknown');
});
test('isolated verification daemon starts with the production configuration', { skip: process.platform !== 'linux' || process.env.RUN_DOCKER_TESTS !== 'true', timeout: 60000 }, async () => {
  const root = await verificationRoot(), config = path.join(root, 'daemon.json');
  assert.ok(Buffer.byteLength(path.join(root, 'exec/containerd/containerd-debug.sock')) < 108);
  await jsonFile(config, daemonConfig(root));
  const env = { ...childEnvironment(), DOCKER_HOST: `unix://${path.join(root, 'docker.sock')}` }; delete env.DOCKER_CONTEXT;
  let diagnostic = '';
  const daemon = spawn('sudo', ['-n', '/usr/bin/dockerd', '--config-file', config], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-65536); });
  const exited = new Promise(resolve => { daemon.once('error', resolve); daemon.once('exit', resolve); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await command('/usr/bin/docker', ['info'], { env }); ready = true; break; } catch { if (daemon.exitCode !== null) break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(ready, true, daemonReason(diagnostic));
  } finally {
    let pid;
    try { pid = (await readFile(path.join(root, 'daemon.pid'), 'utf8')).trim(); } catch { /* Startup may have failed before pid creation. */ }
    if (/^\d+$/.test(pid ?? '')) await command('sudo', ['-n', 'kill', '-TERM', pid]).catch(() => {});
    else daemon.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (daemon.exitCode === null) { if (pid) await command('sudo', ['-n', 'kill', '-KILL', pid]).catch(() => {}); daemon.kill('SIGKILL'); await exited; }
    await command('sudo', ['-n', 'rm', '-rf', '--', root]);
  }
});
