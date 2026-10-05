#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
image=ghcr.io/delinoio/actions-runner-images
tag=${1:-ubuntu-24.04}
case "$tag" in
  ubuntu-24.04|ubuntu-26.04|latest) ;;
  ubuntu24-*|ubuntu26-*) [[ "$tag" =~ ^ubuntu(24|26)-[0-9]+(\.[0-9]+)+-[a-f0-9]{12}-[0-9]+-[0-9]+$ ]] || { printf 'Invalid release tag.\n' >&2; exit 1; } ;;
  *) printf 'Use ubuntu-24.04, ubuntu-26.04, latest, or an immutable release tag.\n' >&2; exit 1 ;;
esac
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  printf 'Run this helper on the Linux x86-64 Docker host.\n' >&2
  exit 1
fi
docker pull --platform linux/amd64 "$image:$tag" >&2
platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image:$tag")
user=$(docker image inspect --format '{{.Config.User}}' "$image:$tag")
volumes=$(docker image inspect --format '{{len .Config.Volumes}}' "$image:$tag")
if [[ "$platform" != linux/amd64 || "$user" != runner || "$volumes" != 0 ]]; then
  printf 'The image does not satisfy the Runmoor configuration contract.\n' >&2
  exit 1
fi
ref=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image:$tag" | awk -v prefix="$image@sha256:" 'index($0,prefix)==1 { print; exit }')
if [[ ! "$ref" =~ ^ghcr\.io/delinoio/actions-runner-images@sha256:[a-f0-9]{64}$ ]]; then
  printf 'The registry digest could not be verified.\n' >&2
  exit 1
fi
printf 'image = "%s"\nrunner_version = "latest"\nrunner_path = "/opt/runmoor-runner"\n' "$ref"
