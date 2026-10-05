// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, writeFile, chmod, chown } from 'node:fs/promises';
import path from 'node:path';
import { Registry, MEDIA } from '../lib/registry.mjs';
import { enumerate, partition, exportLayer, imageConfig } from '../lib/snapshot.mjs';
import { requireHosted, readJSON, jsonFile, command, ubuntu, invariant, reportFailure, log, sha256 } from '../lib/common.mjs';
const os = process.argv[2];
try {
  requireHosted(os); invariant(process.getuid() === 0, 'ROOT_EXPORT_REQUIRED');
  invariant((await command('id', ['-u', 'runner'])).trim() === '1001' && (await command('id', ['-g', 'runner'])).trim() === '1001', 'RUNNER_IDENTITY_MISMATCH');
  const source = await readJSON('.work/source.json'), environment = await readJSON('.work/environment.json');
  const registry = new Registry(); await registry.ensurePrivate();
  const exclusions = [process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP].filter(Boolean);
  const entries = await enumerate('/', exclusions), batches = partition(entries);
  log('snapshot_planned', { os, files: entries.length, layers: batches.length, estimatedBytes: batches.reduce((sum, batch) => sum + batch.bytes, 0) });
  const secrets = Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)).map(([, value]) => value);
  const layers = [];
  for (let index = 0; index < batches.length; index++) layers.push(await exportLayer(registry, '/', batches[index], path.resolve('.work/layers'), index, secrets));
  const supplement = path.resolve('.work/supplement'), metadata = path.join(supplement, 'usr/local/share/runmoor-image');
  await mkdir(metadata, { recursive: true });
  await cp('.work/reporter', path.join(metadata, 'reporter'), { recursive: true });
  await cp('.work/inventory.json', path.join(metadata, 'inventory.json'));
  await cp('LICENSE', path.join(metadata, 'LICENSE.exporter'));
  await cp('third_party/runner-image-blobs/LICENSE', path.join(metadata, 'LICENSE.runner-image-blobs'));
  await jsonFile(path.join(metadata, 'provenance.json'), source);
  for (const directory of ['tmp', 'run', 'proc', 'sys', 'dev', 'home/runner', 'opt/runmoor-runner', 'etc']) await mkdir(path.join(supplement, directory), { recursive: true });
  await chmod(path.join(supplement, 'tmp'), 0o1777);
  await chown(path.join(supplement, 'home/runner'), 1001, 1001); await chown(path.join(supplement, 'opt/runmoor-runner'), 1001, 1001);
  await writeFile(path.join(supplement, 'etc/hosts'), '127.0.0.1 localhost\n::1 localhost\n');
  await writeFile(path.join(supplement, 'etc/hostname'), 'runmoor-runner\n');
  await writeFile(path.join(supplement, 'etc/resolv.conf'), ''); await writeFile(path.join(supplement, 'etc/machine-id'), '');
  // The supplement deliberately supplies runtime scaffolding excluded from the host snapshot.
  const supplementEntries = [];
  async function walk(directory, relative = '.') {
    const { readdir, lstat } = await import('node:fs/promises');
    const stat = await lstat(directory); supplementEntries.push({ path: relative, size: stat.isFile() ? stat.size : 0 });
    if (stat.isDirectory()) for (const name of (await readdir(directory)).sort()) await walk(path.join(directory, name), `${relative}/${name}`);
  }
  await walk(supplement);
  layers.push(await exportLayer(registry, supplement, { files: supplementEntries.map(entry => entry.path) }, path.resolve('.work/layers'), layers.length, secrets));
  const config = await registry.uploadBuffer(Buffer.from(JSON.stringify(imageConfig(environment, layers, source))));
  const body = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: MEDIA.manifest, config: { mediaType: MEDIA.config, ...config }, layers: layers.map(({ mediaType, digest, size }) => ({ mediaType, digest, size })) }));
  const candidate = `candidate-${ubuntu(os)}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const digest = await registry.putManifest(candidate, body);
  await writeFile('.work/manifest.json', body);
  await jsonFile('.work/candidate.json', { candidate, digest, layers, uncompressed: layers.reduce((sum, layer) => sum + layer.uncompressed, 0), source });
  log('candidate_exported', { os, digest, layers: layers.length });
} catch (error) { reportFailure(error); process.exitCode = 1; }
