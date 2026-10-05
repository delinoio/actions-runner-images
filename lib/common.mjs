// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const REPOSITORY = 'delinoio/actions-runner-images';
export const STATE_BRANCH = 'image-status';
export const PACKAGE = 'actions-runner-images';
export const IMAGE = `ghcr.io/delinoio/${PACKAGE}`;
export const OS = Object.freeze({ Ubuntu24: '24.04', Ubuntu26: '26.04' });
export class Failure extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export function invariant(condition, code) { if (!condition) throw new Failure(code); }
export function sha256(data) { return `sha256:${createHash('sha256').update(data).digest('hex')}`; }
export function log(event, fields = {}) {
  // Never pass HTTP bodies, upload URLs, arbitrary environment values, or exception messages here.
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}
export function reportFailure(error) { log('failed', { code: error.code ?? 'UNEXPECTED_FAILURE', ...(error.status ? { status: error.status } : {}) }); }
export function childEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION/i.test(key)) delete env[key];
  delete env.NODE_OPTIONS;
  return env;
}
export async function command(file, args, options = {}) {
  const { input, capture = true, ...rest } = options;
  const child = spawn(file, args, { env: childEnvironment(), stdio: ['pipe', capture ? 'pipe' : 'inherit', 'pipe'], ...rest });
  const output = [];
  // Child stderr can contain private paths or credentials. Report only the exit status.
  child.stderr.resume();
  if (capture) child.stdout.on('data', chunk => output.push(chunk));
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  await new Promise((resolve, reject) => {
    child.on('error', () => reject(new Failure('COMMAND_START_FAILED')));
    child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Failure(signal ? 'COMMAND_INTERRUPTED' : 'COMMAND_FAILED', code)));
  });
  return capture ? Buffer.concat(output).toString('utf8') : '';
}
export async function jsonFile(path, data) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(data, null, 2)}\n`); }
export async function readJSON(path) { return JSON.parse(await readFile(path, 'utf8')); }
export function ubuntu(os) { invariant(Object.values(OS).includes(os), 'UNSUPPORTED_UBUNTU'); return `ubuntu${os.slice(0, 2)}`; }
export function compareVersion(a, b) {
  invariant(/^\d+(\.\d+)+$/.test(a) && /^\d+(\.\d+)+$/.test(b), 'INVALID_IMAGE_VERSION');
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  return 0;
}
export function requireHosted(os) {
  invariant(process.platform === 'linux' && process.arch === 'x64', 'LINUX_AMD64_REQUIRED');
  invariant(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'DISPOSABLE_HOSTED_RUNNER_REQUIRED');
  invariant(process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_REF === 'refs/heads/main', 'TRUSTED_MAIN_REQUIRED');
  invariant(process.env.ImageOS === ubuntu(os), 'HOST_IMAGE_OS_MISMATCH');
  invariant(/^\d+(\.\d+)+$/.test(process.env.ImageVersion ?? ''), 'HOST_IMAGE_VERSION_REQUIRED');
}
