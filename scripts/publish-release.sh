#!/usr/bin/env bash
# Idempotent release steps: each checks whether its target already has this
# version before acting, so a release job that failed halfway can be re-run
# from the top (npm refuses to publish an existing version twice).
# Usage: scripts/publish-release.sh <npm|github|registry> <version>
set -euo pipefail
cd "$(dirname "$0")/.."

usage='usage: scripts/publish-release.sh <npm|github|registry> <version>'
step=${1:?$usage}
version=${2:?$usage}
package=nbg-rates-mcp
server=io.github.akalongman/nbg-rates

publish_npm() {
    if [ "$(npm view "$package@$version" version 2> /dev/null || true)" = "$version" ]; then
        echo "$package@$version is already on npm"
        return
    fi
    npm publish --access public
}

publish_github() {
    if gh release view "v$version" > /dev/null 2>&1; then
        echo "GitHub release v$version already exists"
        return
    fi
    gh release create "v$version" "$package-$version.mcpb" --title "v$version" --notes-file CHANGELOG.md
}

# SHA-256 of each mcp-publisher release tarball, copied from the release's
# registry_1.8.1_checksums.txt. A version bump changes the tag and all four values.
publisher_tag=v1.8.1
publisher_sha256() {
    case "$1" in
        linux_amd64) echo a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc ;;
        linux_arm64) echo 8dd75a6cf6845688b5d4e46df58d3ca26d5c8d233bb0626606e1db82c5e883e4 ;;
        darwin_amd64) echo 88126981225e7714fcc6b7a10cdba4a80ae5901e9740a8c06d0d5195c8bc294c ;;
        darwin_arm64) echo e45e520892460732a4bdf37255576415d4a53ec171f8b913faf15bb1aef7cb77 ;;
        *) return 1 ;;
    esac
}

sha256_of() {
    if command -v sha256sum > /dev/null; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
}

publish_registry() {
    local status platform expected tarball actual
    status=$(curl -s -o /dev/null -w '%{http_code}' \
        "https://registry.modelcontextprotocol.io/v0.1/servers/${server/\//%2F}/versions/$version")
    if [ "$status" = 200 ]; then
        echo "the MCP registry already lists $server $version"
        return
    fi
    platform="$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
    if ! expected=$(publisher_sha256 "$platform"); then
        echo "mcp-publisher $publisher_tag has no pinned checksum for $platform; supported: linux and darwin on amd64 and arm64" >&2
        exit 1
    fi
    # Global, not local: the EXIT trap runs after this function has returned.
    publisher_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mcp-publisher.XXXXXX")
    trap 'rm -rf "$publisher_dir"' EXIT
    tarball="$publisher_dir/mcp-publisher_$platform.tar.gz"
    curl -sSfL -o "$tarball" \
        "https://github.com/modelcontextprotocol/registry/releases/download/$publisher_tag/mcp-publisher_$platform.tar.gz"
    actual=$(sha256_of "$tarball")
    if [ "$actual" != "$expected" ]; then
        echo "mcp-publisher_$platform.tar.gz has SHA-256 $actual, expected $expected; not running it" >&2
        exit 1
    fi
    tar -xzf "$tarball" -C "$publisher_dir" mcp-publisher
    "$publisher_dir/mcp-publisher" login github-oidc
    "$publisher_dir/mcp-publisher" publish
}

case "$step" in
    npm) publish_npm ;;
    github) publish_github ;;
    registry) publish_registry ;;
    *)
        echo "$usage" >&2
        exit 2
        ;;
esac
