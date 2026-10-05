// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { invariant } from './common.mjs';

export async function verificationRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'runmoor-verify-'));
  // containerd also creates a longer debug socket below exec-root. A checkout
  // path can exceed Linux sockaddr_un's 108-byte limit before Docker starts.
  invariant(Buffer.byteLength(path.join(root, 'exec/containerd/containerd-debug.sock')) < 108, 'VERIFICATION_SOCKET_PATH_TOO_LONG');
  return root;
}
export function daemonConfig(root) {
  return { 'data-root': path.join(root, 'data'), 'exec-root': path.join(root, 'exec'), pidfile: path.join(root, 'daemon.pid'), hosts: [`unix://${path.join(root, 'docker.sock')}`], 'storage-driver': 'overlay2', features: { 'containerd-snapshotter': false }, iptables: false, 'ip-masq': false, 'ip-forward': false, bridge: 'none' };
}
export function daemonReason(stderr) {
  if (/invalid argument|address.*too long/i.test(stderr)) return 'socket-path';
  if (/unknown.*storage|storage.*not supported|failed to mount overlay/i.test(stderr)) return 'storage-driver';
  if (/network controller|iptables/i.test(stderr)) return 'network';
  if (/permission denied|operation not permitted/i.test(stderr)) return 'permissions';
  if (/pid file|process.*running/i.test(stderr)) return 'pid-conflict';
  return 'unknown';
}
