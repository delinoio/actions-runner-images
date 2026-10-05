# Actions runner images

Private Docker snapshots of the complete GitHub-hosted Ubuntu software inventory for Runmoor. The build code is public. The software images are private GHCR packages.

Supported images: Ubuntu 24.04 and 26.04, Linux x86-64. Each includes that OS's installed SDKs, every NDK and toolcache version, languages, Java installations, browsers, and other preinstalled tools. Ubuntu versions have different official inventories.

[Publication status and digests](https://github.com/delinoio/actions-runner-images/blob/image-status/images.json) · [Workflow runs](https://github.com/delinoio/actions-runner-images/actions)

## Use with Runmoor

Run these commands on the Linux Docker host. Docker login uses a GitHub classic PAT with `read:packages` and access to the private package.

```sh
git clone https://github.com/delinoio/actions-runner-images.git
cd actions-runner-images
docker login ghcr.io -u kdy1
./scripts/pull-image.sh ubuntu-24.04
```

Use `ubuntu-26.04` for Ubuntu 26.04. The helper pulls the image and prints its actual immutable digest and these fields for your existing Docker pool:

```toml
image = "ghcr.io/delinoio/actions-runner-images@sha256:<actual digest>"
runner_version = "latest"
runner_path = "/opt/runmoor-runner"
```

Run `runmoor config validate` after applying the fields, then follow your existing manager's configuration reload procedure. Toolchains are already installed in the image. The helper does not modify configuration, start services, or install tools on the host.

Keep the dedicated runner path. Runmoor replaces that directory during automatic runner preparation; the home directory contains installed toolchains. Current Runmoor does not forward private registry credentials during image pulls, so pre-pull the chosen digest with Docker CLI.

## Updates

Generated check metadata is committed only to the `image-status` branch so the organization's protected `main` remains unchanged. The workflow checks both fixed Ubuntu labels daily at 11:23 KST, on recipe changes, and on manual dispatch. New source or exporter versions produce private candidates. Verified candidates update their OS alias and receive unique immutable tags. `latest` follows GitHub's documented default Ubuntu OS. Only the most recent four successful versions per OS are retained.

Updates publish new images. You choose when to pull and change Runmoor's digest. A failed build keeps existing deployed versions; inspect the workflow status for failures or versions waiting for an official stable release.

If a complete candidate uploaded but acceptance failed, maintainers can run **Verify and publish an existing private candidate** with the original publication run ID and OS. It repeats full acceptance before promotion and preserves the original build provenance. **Check private registry transport** tests deterministic uploads without exporting software or changing tags.

## Publisher setup

The `registry-publish` GitHub environment permits `main` only. It needs `GHCR_PUBLISH_TOKEN`, a classic PAT with `write:packages` and `delete:packages`, which implies package read access. Exclude the broad `repo` scope. `GHCR_USERNAME` defaults to `kdy1`.

The initial token expires on **2027-01-03**. Replace the environment Secret before expiry. Never put tokens in issues, source, shell arguments, or image layers.

Keep the GHCR package **private and unlinked to this public repository**. Do not enable permission inheritance or grant this public repository Actions/Codespaces access. Workflows verify private visibility before software upload. Package publication does not use `GITHUB_TOKEN`.

## Compatibility and licenses

The images match installed software and versions. Containers use their host kernel and Runmoor's permission limits. VM service control, passwordless sudo, nested daemons, and hardware/emulator operation need the corresponding runtime support. Container verification checks software reports and offline compilation; it does not certify a real Runmoor account job.

Repository-owned code is Apache-2.0. The vendored exporter reference is MIT. Bundled tools retain their original licenses and notices; the source license does not license the entire software image.

The implementation uses the [official runner-images release inventory](https://github.com/actions/runner-images) and a reviewed, [revision-pinned exporter reference](third_party/runner-image-blobs/README.md). It does not consume a community-built runner image.
