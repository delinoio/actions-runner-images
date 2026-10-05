# Repository instructions

- Read the files in `docs/` before each task. `docs/image-contract.md` owns the image, publication, and retention contract. Update this file and that contract together when policy changes.
- Keep repository-owned source under Apache-2.0. Preserve the MIT source and notices under `third_party/`. Bundled software keeps its original licenses; never describe the whole image as Apache-2.0.
- Keep this repository public and its GHCR package private, unlinked to repositories, without inherited repository or Actions access. Publish only from trusted `main` executions through the `registry-publish` environment.
- Write generated check/publication state only to `image-status`. Preserve the organization's main protection; never add a token with repository scope to bypass it.
- Never commit credentials, SDK binaries, rootfs archives, OCI layers, or raw host/job content. Do not upload them to public Actions artifacts or caches. Public records contain only source revisions, tool versions, digests, sizes, and sanitized validation outcomes.
- Do not automatically change Runmoor configuration or add work to a user CI machine. Destructive storage reclamation is allowed only on a disposable GitHub-hosted export job after a complete candidate upload.
- Preserve the full per-OS installed software and tool caches. Changes to exclusion policy or report adapters require tests. Unknown source or report changes must fail without promoting aliases.
- GHCR uploads use one streaming PATCH per layer. Retry a transient failure by regenerating that layer, up to four attempts; never resume unsupported multi-PATCH uploads or stage a complete image.
- Keep actions pinned to commit SHAs. Never execute the vendored reference workflow. Do not automatically sync exporter code from upstream.
- Run `npm test` and shell syntax checks before committing. The Linux CI additionally runs the Docker fixture. Record actual image acceptance separately from fixture results in CI outputs.
- Use English for code and comments. Use structured logs with stable event/error codes. Never log tokens, upload URLs, arbitrary environment values, or raw HTTP/child error bodies.
- Commit intended changes after staging. Do not use `--no-verify`. Every repository-owned `dist` directory is ignored generated output. Track any repository asset of at least 512 KiB with an exact-path Git LFS attribute.
