#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
openkey_ref="$(tr -d '[:space:]' < "$repo_root/openkey-sdk.ref")"

if [[ ! "$openkey_ref" =~ ^[0-9a-f]{40}$ ]]; then
  echo "openkey-sdk.ref must contain one full Git commit SHA" >&2
  exit 1
fi

openkey_context="${OPENKEY_SDK_CONTEXT:-https://github.com/TinyCloudLabs/openkey.git#$openkey_ref}"

docker buildx build \
  --build-context "openkey-src=$openkey_context" \
  --file "$repo_root/harness/openkey-sdk/Dockerfile" \
  --target artifact \
  --output "type=local,dest=$repo_root/vendor/openkey-sdk" \
  "$repo_root/harness/openkey-sdk"
