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
    # The tarball the build job packed: the publish job installs no dependencies, so a folder publish, whose
    # prepublishOnly script builds, cannot run there.
    npm publish "$package-$version.tgz" --access public
}

# The body of this version's "## <version> - <date>" section in CHANGELOG.md.
release_notes() {
    awk -v heading="## $version - " '
        index($0, heading) == 1 { found = 1; next }
        found && /^## / { exit }
        found { print }
    ' CHANGELOG.md
}

publish_github() {
    local bundle="$package-$version.mcpb" complete notes
    if ! complete=$(gh release view "v$version" --json isDraft,assets \
        --jq "(.isDraft | not) and any(.assets[]; .name == \"$bundle\")" 2> /dev/null); then
        notes=$(release_notes)
        if [ -z "${notes//[[:space:]]/}" ]; then
            echo "CHANGELOG.md has no notes under ## $version" >&2
            exit 1
        fi
        gh release create "v$version" "$bundle" --title "v$version" --notes "$notes"
        return
    fi
    if [ "$complete" = true ]; then
        echo "GitHub release v$version already exists with $bundle"
        return
    fi
    # gh creates a release as a draft and publishes it after the upload, so a
    # cancelled run leaves a draft or a release without the bundle: finish it.
    gh release upload "v$version" "$bundle" --clobber
    gh release edit "v$version" --draft=false
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

# npm processes a publish asynchronously: for a minute or two after npm publish
# returns, the version URL can answer 404, and the MCP registry rejects a server
# whose package version it cannot fetch. Poll the URL its validator fetches.
npm_wait_checks=40
npm_wait_seconds=15
wait_for_npm() {
    local url="https://registry.npmjs.org/$package/$version" check status
    for ((check = 1; check <= npm_wait_checks; check++)); do
        status=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' "$url" || true)
        if [ "$status" = 200 ]; then
            return
        fi
        if [ "$check" -lt "$npm_wait_checks" ]; then
            echo "npm answers $status for $package@$version; checking again in ${npm_wait_seconds}s ($check/$npm_wait_checks)"
            sleep "$npm_wait_seconds"
        fi
    done
    echo "npm still answers $status for $package@$version after $npm_wait_checks checks ${npm_wait_seconds}s apart; not publishing to the MCP registry" >&2
    exit 1
}

publish_registry() {
    local status platform expected tarball actual
    status=$(curl -s -o /dev/null -w '%{http_code}' \
        "https://registry.modelcontextprotocol.io/v0.1/servers/${server/\//%2F}/versions/$version")
    if [ "$status" = 200 ]; then
        echo "the MCP registry already lists $server $version"
        return
    fi
    wait_for_npm
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
