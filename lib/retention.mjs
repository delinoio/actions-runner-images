// SPDX-License-Identifier: Apache-2.0
import { compareVersion, invariant } from './common.mjs';
const RELEASE = /^ubuntu(24|26)-(\d+(?:\.\d+)+)-([a-f0-9]{12})-(\d+)-(\d+)$/;
const CANDIDATE = /^candidate-ubuntu(?:24|26)-\d+-\d+$/;
export function retentionPlan(versions, protectedDigests, keep = 4, now = Date.now()) {
  invariant(keep === 4, 'RETENTION_POLICY_CHANGED');
  const remove = [], groups = new Map([['24', []], ['26', []]]);
  for (const version of versions) {
    if (protectedDigests.has(version.name)) continue;
    const tags = version.metadata?.container?.tags ?? [];
    const releases = tags.map(tag => RELEASE.exec(tag)).filter(Boolean);
    // Refuse to delete a version with any tag not owned by this exporter.
    if (tags.some(tag => !RELEASE.test(tag) && !CANDIDATE.test(tag) && tag !== 'bootstrap-private')) continue;
    if (releases.length === 1) groups.get(releases[0][1]).push({ version, release: releases[0] });
    else if (releases.length === 0 && tags.length && now - Date.parse(version.created_at) > 24 * 60 * 60_000) remove.push(version.id);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => compareVersion(b.release[2], a.release[2]) || Date.parse(b.version.created_at) - Date.parse(a.version.created_at));
    // Current aliases are already protected and count towards the four retained versions.
    const os = group[0]?.release[1];
    const protectedCount = versions.filter(version => protectedDigests.has(version.name) && (version.metadata?.container?.tags ?? []).some(tag => RELEASE.exec(tag)?.[1] === os)).length;
    remove.push(...group.slice(Math.max(0, keep - protectedCount)).map(item => item.version.id));
  }
  return [...new Set(remove)];
}
