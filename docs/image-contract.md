# Image and publication contract

## Ownership and interfaces

The public source repository is `delinoio/actions-runner-images`. Its sole package is `ghcr.io/delinoio/actions-runner-images`, a private, repository-unlinked GHCR container package. Code, tool-version reports, and digest metadata may be public. Software payloads and credentials must remain private.

The supported platforms are Ubuntu 24.04 and 26.04, Linux amd64. Stable aliases are `ubuntu-24.04`, `ubuntu-26.04`, and `latest`. `latest` follows the official runner-images README's x64 `ubuntu-latest` mapping. Unknown future OS mappings stop updates to `latest` without selecting a substitute.

Release tags have the form `ubuntu24-<ImageVersion>-<recipeHash12>-<runId>-<attempt>` or the corresponding `ubuntu26` form. A release tag is never overwritten. Candidate tags are unique per OS, workflow run, and attempt. Registry retention can delete old immutable releases after four newer successful versions are available for that OS.

`images.json` on the `image-status` branch is generated publication/check metadata. The file on `main` is only its initial schema template. Status updates must not bypass or change the organization's protected-main rules. It is excluded from the recipe hash. The pull helper accepts `ubuntu-24.04`, `ubuntu-26.04`, `latest`, or an immutable release tag, pulls through the caller's Docker authentication, and prints a digest-pinned Runmoor configuration fragment. It never changes configuration or starts a daemon.

## Source and filesystem

Use the actual fixed-label GitHub-hosted VM and a stable official release matching its complete `ImageVersion`. Never infer the image version from a mutable label. Record the official release commit, exporter revision, recipe hash, source inventory hash, layer sizes/digests, and final digest. This establishes provenance, not bit-for-bit reproducibility of GitHub's VM.

Preserve installed software, all cached versions and completion markers, Android packages and every installed NDK, static tool environment defaults, permissions, links, and component licenses. Preserve mounted `/snap` contents. Preserve known tool-data home directories; do not copy arbitrary home data. Explicit exclusions remove host identities, authentication files, job checkouts, registered runners, virtual filesystems, temporary files, logs, and daemon runtime storage. Stream tar data through credential-value detection, SHA-256, gzip, and bounded registry uploads. Use one streaming PATCH per layer because GHCR rejects consecutive PATCH chunks. Retry transient upload failures by regenerating the affected layer, with at most four attempts and nine minutes per request. Never stage a complete image. Any unreadable/changing source, credential detection, oversized file, or unsupported layer count fails the build.

The image account is `runner`, UID/GID 1001. The image declares no Volumes. `/opt/runmoor-runner` is an empty writable runner-only directory so Runmoor preparation cannot replace the toolchain-bearing home directory.

## Credentials and trust

Only trusted `main` workflow events may access the `registry-publish` environment. Use a classic PAT with package write/delete permission, implied package read permission, and no repository scope. The publisher's identity must match `GHCR_USERNAME`. Classic PAT package scopes are account scopes; exporter operations are restricted to the exact package named above.

An initial empty-rootfs manifest establishes the package before software upload. Verify package identity, private visibility, no linked repository, and denied anonymous token-based read access on every publication. Do not add `org.opencontainers.image.source`, use `GITHUB_TOKEN` for package publication, or grant the public repository package Actions/Codespaces access. Package access settings remain separate from public repository access.

Fork/PR CI uses fixtures without credentials. All actions are SHA-pinned. The vendored MIT exporter is a non-executed reference. Official report modules are fetched only from the matched release commit; unknown probe changes fail closed. Images contain the modules, their license, and the software-version inventory.

## Validation and promotion

A private candidate is not a successful release. After upload, a disposable VM may reclaim explicitly listed exported tool directories. Preserve the Actions control runtime and a copied Node executable. Use a separate classic overlay2 Docker daemon to avoid retaining compressed content alongside extracted layers. Check free space before pulling. Never run this reclamation on a user machine.

Candidate acceptance requires a private registry roundtrip, valid image configuration, exact normalized software and apt-package inventories, and offline compilation in a runner-user container with dropped capabilities and no-new-privileges. Compilation checks cover C/C++, Rust, Go, Java, .NET, Android SDK resource linking and DEX generation, and every installed NDK; Node and Python also execute simple programs. The report adapter replaces host-kernel reporting, ownership repair, live Docker-daemon version queries, and live web-service state. It joins multiple virtual-package version results into one table cell without dropping versions; the separate full dpkg inventory retains every actual package name and version. It retains installed tool versions and all tool/cache sections. Docker/OS fixture tests do not certify a real Runmoor account job.

Only verified candidates may receive release tags or stable aliases. Before writing aliases, save their previous manifests. Restore existing aliases on a failed multi-tag promotion. GHCR has no multi-tag transaction or individual-tag deletion API: an initial alias with no predecessor, or failed rollback, is an explicitly failed partial promotion of an already verified image. Do not claim success or silently delete a digest still referenced by an alias. The next trusted run reconciles state.

Retain four owned release versions per OS, including protected current aliases. Each OS deletes only its own release and candidate versions. Never delete a version carrying an unrecognized tag or any other OS's tag. Failed candidate-only versions and the empty bootstrap can be deleted after 24 hours; Ubuntu 24.04 alone owns shared bootstrap cleanup. All registry mutations target this package only.

## Scheduling and operations

Check daily at 02:23 UTC (11:23 KST), on recipe changes, and on manual dispatch. Skip unchanged source/recipe pairs. Do not downgrade an OS alias. Serialize publication workflows; build OS candidates in parallel and let each OS report its own outcome. Pin one official main README revision before the matrix starts so the jobs share one default-OS decision and only one job can write `latest`. Keep each OS's retention operations separate. Actual check-state commits on `image-status` keep the public repository active and do not trigger new publication builds.

The manual registry transport check uses deterministic public fixtures on trusted `main` in the same protected environment. It verifies private visibility and both large streamed and small compressed uploads without copying host software or changing image tags. Publication runs perform these same probes before collecting software.

Manual candidate recovery may retry acceptance and promotion without exporting software again. It requires a trusted-main publication run, its public inventory artifact and structured layer descriptors, and the matching private candidate manifest digest. Preserve the original build revision and recipe hash, verify the full container again, and use a freshly pinned official default-OS mapping. Recovery shares the publication concurrency group. Its isolated Docker storage uses a short temporary path to remain within Linux's Unix socket limit.

Record success, waiting-for-release, failure, or unchanged results without credentials or raw host content. Scheduled jobs can be delayed by GitHub. Expired/revoked credentials fail visibly and preserve deployed digests. The initial publishing PAT expires on 2027-01-03; rotate its environment Secret before expiry.

Toolchain publication never updates user Runmoor configuration. The Linux host authenticates and pre-pulls the chosen digest with Docker CLI because current Runmoor image pulls do not forward private registry authentication. Docker kernels, system services, sudo, nested daemons, hardware access, and emulator availability have runtime-specific limits despite matching installed tools.
