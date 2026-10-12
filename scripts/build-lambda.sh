#!/usr/bin/env bash
# Builds the Lambda zip from the npm tarball the build job packed: the
# package exactly as npm serves it, plus its production dependencies.
# Usage: scripts/build-lambda.sh <version>
# PACKAGE_LOCK may point at the lock file to use; default: the checkout's.
set -euo pipefail

version=${1:?usage: scripts/build-lambda.sh <version>}
package=nbg-rates-mcp
tarball="$package-$version.tgz"
target="$PWD/$package-$version-lambda.zip"
lock=${PACKAGE_LOCK:-"$(cd "$(dirname "$0")/.." && pwd)/package-lock.json"}

[ -f "$tarball" ] || { echo "$tarball is not here; download the release artifact first" >&2; exit 1; }

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lambda-build.XXXXXX")
trap 'rm -rf "$work"' EXIT

tar -xzf "$tarball" -C "$work"
# npm's tarball root is package/. The tarball carries no lock file; the one
# at the tag is what the package was built from.
cp "$lock" "$work/package/package-lock.json"
(
    cd "$work/package"
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund > /dev/null
    rm -f "$target"
    zip -X -r -q "$target" dist node_modules package.json
)
echo "built $(basename "$target")"
