# Vendored exporter reference

Source: https://github.com/ChristopherHX/runner-image-blobs

Revision: `96c58e2540a8c11351aed1269df0553663a1b8d7`

Original file: `.github/workflows/dump.yml`

`dump.yml.reference` is an audit reference under the accompanying MIT license. It is not an executable workflow. Its filesystem-to-tar-to-registry design informed this repository's exporter. Authentication, layer partitioning, privacy checks, retries, inventory validation, and publication are implemented separately here. Upstream code updates are reviewed manually.
