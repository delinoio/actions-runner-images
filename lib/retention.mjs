// SPDX-License-Identifier: Apache-2.0
import { compareVersion, invariant, ubuntu } from './common.mjs';
const RELEASE = /^ubuntu(24|26)-(\d+(?:\.\d+)+)-([a-f0-9]{12})-(\d+)-(\d+)$/;
const CANDIDATE = /^candidate-ubuntu(24|26)-\d+-\d+$/;
export function retentionPlan(versions, protectedDigests, { os, keep = 4, now = Date.now() } = {}) {
  const selected = ubuntu(os).slice('ubuntu'.length);
  invariant(keep === 4, 'RETENTION_POLICY_CHANGED');
  const remove = [], group = [];
  for (const version of versions) {
    if (protectedDigests.has(version.name)) continue;
    const tags = version.metadata?.container?.tags ?? [];
    const releases = tags.map(tag => RELEASE.exec(tag)).filter(Boolean);
    // Refuse to delete a version with any tag not owned by this exporter.
    if (tags.some(tag => !RELEASE.test(tag) && !CANDIDATE.test(tag) && tag !== 'bootstrap-private')) continue;
    // Parallel OS jobs never delete one another's versions or active candidates.
    if (tags.some(tag => (RELEASE.exec(tag)?.[1] ?? CANDIDATE.exec(tag)?.[1] ?? selected) !== selected)) continue;
    // Only one OS owns shared bootstrap cleanup, avoiding a concurrent deletion.
    if (tags.includes('bootstrap-private') && os !== '24.04') continue;
    if (releases.length === 1) group.push({ version, release: releases[0] });
    else if (releases.length === 0 && tags.length && now - Date.parse(version.created_at) > 24 * 60 * 60_000) remove.push(version.id);
  }
  group.sort((a, b) => compareVersion(b.release[2], a.release[2]) || Date.parse(b.version.created_at) - Date.parse(a.version.created_at));
  // Current aliases are already protected and count towards the four retained versions.
  const protectedCount = versions.filter(version => protectedDigests.has(version.name) && (version.metadata?.container?.tags ?? []).some(tag => RELEASE.exec(tag)?.[1] === selected)).length;
  remove.push(...group.slice(Math.max(0, keep - protectedCount)).map(item => item.version.id));
  return [...new Set(remove)];
}
