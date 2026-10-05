// SPDX-License-Identifier: Apache-2.0
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitHub } from './github.mjs';
import { invariant, ubuntu, compareVersion, command, sha256, childEnvironment } from './common.mjs';
import { recipeFingerprint } from './snapshot.mjs';

export function latestUbuntu(readme) {
  const rows = readme.split('\n').filter(line => /^\|/.test(line) && /Ubuntu/.test(line) && /ubuntu-latest/.test(line) && !/arm64/i.test(line));
  invariant(rows.length === 1, 'LATEST_UBUNTU_MAPPING_UNKNOWN');
  const matches = [...rows[0].matchAll(/ubuntu-(\d+\.\d+)/g)].map(match => match[1]);
  const os = [...new Set(matches)].filter(value => value === '24.04' || value === '26.04');
  invariant(os.length === 1, 'LATEST_UBUNTU_UNSUPPORTED'); return os[0];
}
export function matchingRelease(releases, os, version) {
  const short = version.split('.').slice(0, -1).join('.');
  return releases.find(release => !release.draft && !release.prerelease && release.tag_name === `${ubuntu(os)}/${short}`) ?? null;
}
export async function checkSource(os, github = new GitHub()) {
  const main = await github.json('/repos/actions/runner-images/commits/main');
  let latestOS = null, latestError = null;
  try { latestOS = latestUbuntu(await github.contents('README.md', main.sha)); } catch (error) { latestError = error.code ?? 'LATEST_UBUNTU_MAPPING_UNKNOWN'; }
  let release;
  for (let page = 1; page <= 5 && !release; page++) {
    const releases = await github.json(`/repos/actions/runner-images/releases?per_page=100&page=${page}`);
    release = matchingRelease(releases, os, process.env.ImageVersion); if (releases.length < 100) break;
  }
  if (!release) return { available: false, latestOS, latestError, reason: 'HOST_VERSION_NOT_IN_STABLE_RELEASE' };
  let ref = await github.json(`/repos/actions/runner-images/git/ref/tags/${release.tag_name}`);
  if (ref.object.type === 'tag') ref = { object: await github.json(`/repos/actions/runner-images/git/tags/${ref.object.sha}`) };
  const sourceRevision = ref.object.type === 'commit' ? ref.object.sha : ref.object.object?.sha;
  invariant(/^[a-f0-9]{40}$/.test(sourceRevision), 'SOURCE_COMMIT_UNRESOLVED');
  const reportPath = `images/ubuntu/Ubuntu${os.replace('.', '')}-Readme.md`;
  const report = await github.contents(reportPath, sourceRevision);
  invariant(report.match(/Image Version:\s*([^\s]+)/)?.[1] === process.env.ImageVersion, 'RELEASE_IMAGE_VERSION_MISMATCH');
  return { available: true, sourceRevision, releaseTag: release.tag_name, latestOS, latestError, officialReportHash: sha256(report) };
}
export function shouldBuild(previous, imageVersion, recipeHash, force = false) {
  if (!previous?.published) return true;
  invariant(compareVersion(imageVersion, previous.published.imageVersion) >= 0, 'HOST_VERSION_DOWNGRADE');
  return force || previous.published.imageVersion !== imageVersion || previous.published.recipeHash !== recipeHash;
}
export async function fingerprint() {
  const names = (await command('git', ['ls-files', '-z', 'lib', 'scripts', '.github/workflows', 'third_party', 'package.json'])).split('\0').filter(Boolean);
  return recipeFingerprint(await Promise.all(names.map(async name => [name, await readFile(name)])));
}

// These adaptations change VM probes, not the installed software list. Fail closed when upstream changes the expected probes.
export function adaptReport(name, source) {
  if (name === 'Generate-SoftwareReport.ps1') {
    invariant(source.includes('sudo chown -R ${env:USER}: $env:HOME'), 'UPSTREAM_CHOWN_PROBE_CHANGED');
    source = source.replace('sudo chown -R ${env:USER}: $env:HOME', '# Home ownership is preserved by the snapshot exporter.');
    invariant(source.includes('$softwareReport.Root.AddToolVersion("Kernel Version:", $(Get-KernelVersion))'), 'UPSTREAM_KERNEL_PROBE_CHANGED');
    source = source.replace('$softwareReport.Root.AddToolVersion("Kernel Version:", $(Get-KernelVersion))', '# The host kernel belongs to the container runtime.');
    const trap = `trap {
    [Console]::Error.WriteLine((@{ event = 'software_report_failed'; exception = $_.Exception.GetType().FullName; script = [IO.Path]::GetFileName($_.InvocationInfo.ScriptName); line = $_.InvocationInfo.ScriptLineNumber } | ConvertTo-Json -Compress))
    exit 1
}
`;
    source = source.replace('Set-StrictMode -Version Latest', 'Set-StrictMode -Version Latest\n' + trap);
    source = source.split('\n').flatMap(line => {
      const probe = line.match(/\$\((Get-[A-Za-z0-9]+)\b/);
      return probe ? [line.match(/^\s*/)[0] + `[Console]::Error.WriteLine('{"event":"report_probe","probe":"${probe[1]}"}')`, line] : [line];
    }).join('\n');
  }
  if (name === 'SoftwareReport.Tools.psm1') {
    invariant(source.includes("sudo docker version --format '{{.Client.Version}}'") && source.includes("sudo docker version --format '{{.Server.Version}}'"), 'UPSTREAM_DOCKER_PROBES_CHANGED');
    source = source.replace("sudo docker version --format '{{.Client.Version}}'", "(docker --version).Split(' ')[2].TrimEnd(',')");
    source = source.replace("sudo docker version --format '{{.Server.Version}}'", "(dockerd --version).Split(' ')[2].TrimEnd(',')");
  }
  if (name === 'SoftwareReport.WebServers.psm1') {
    const probes = [
      '$serviceStatus = systemctl status apache2 | grep "Active:" | Get-StringPart -Part 1',
      '$serviceStatus = systemctl status nginx | grep "Active:" | Get-StringPart -Part 1',
    ];
    for (const probe of probes) {
      invariant(source.includes(probe), 'UPSTREAM_SERVICE_PROBE_CHANGED');
      source = source.replace(probe, "$serviceStatus = 'runtime-managed'");
    }
  }
  return source;
}
export async function prepareReport(revision, destination, github = new GitHub(), os) {
  const tree = await github.json(`/repos/actions/runner-images/git/trees/${revision}?recursive=1`);
  invariant(!tree.truncated, 'SOURCE_TREE_TRUNCATED');
  const files = tree.tree.filter(item => item.type === 'blob' && (
    /^images\/ubuntu\/scripts\/docs-gen\/(?:Generate-SoftwareReport\.ps1|SoftwareReport\.[A-Za-z]+\.psm1)$/.test(item.path) ||
    item.path === 'images/ubuntu/scripts/helpers/Common.Helpers.psm1' ||
    /^helpers\/software-report-base\/[^/]+\.psm1$/.test(item.path)
  ));
  invariant(files.some(item => item.path.endsWith('Generate-SoftwareReport.ps1')) && files.length >= 15, 'REPORT_SOURCE_INCOMPLETE');
  // Keep the official module layout and upstream MIT license with the adapted copies.
  for (const item of files) {
    const relative = item.path.startsWith('helpers/') ? `docs-gen/software-report-base/${path.basename(item.path)}` : item.path.replace('images/ubuntu/scripts/', '');
    const target = path.join(destination, relative); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, adaptReport(path.basename(item.path), await github.contents(item.path, revision)));
  }
  invariant(['24.04', '26.04'].includes(os), 'REPORT_OS_REQUIRED');
  await mkdir(path.join(destination, 'installers'), { recursive: true });
  await writeFile(path.join(destination, 'installers/toolset.json'), await github.contents(`images/ubuntu/toolsets/toolset-${os.replace('.', '')}.json`, revision));
  await writeFile(path.join(destination, 'LICENSE.runner-images'), await github.contents('LICENSE', revision));
}
export async function generateReport(directory, output) {
  await mkdir(output, { recursive: true });
  await command('pwsh', ['-NoLogo', '-NoProfile', '-File', path.join(directory, 'docs-gen/Generate-SoftwareReport.ps1'), '-OutputDirectory', output], { env: { ...childEnvironment(), IMAGE_VERSION: process.env.ImageVersion, INSTALLER_SCRIPT_FOLDER: path.join(directory, 'installers') }, safeEvents: ['report_probe', 'software_report_failed'] });
  return JSON.parse(await readFile(path.join(output, 'software-report.json'), 'utf8'));
}
export function normalizeReport(report) {
  // Only these root fields describe the VM host. Tool sections and cache versions remain exact.
  invariant(report?.NodeType === 'HeaderNode' && Array.isArray(report.Children), 'REPORT_SCHEMA_CHANGED');
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
      if (result.NodeType === 'ToolVersionsListNode' && Array.isArray(result.Versions)) result.Versions.sort();
      if (result.NodeType === 'TableNode' && Array.isArray(result.Rows)) result.Rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return result;
    }
    return value;
  }
  return canonical(report);
}
