#!/usr/bin/env bash
# Creates or updates each ruleset defined in .github/rulesets/ on this
# repository's GitHub remote, matched by name, so the protection of main and of
# the release tags lives in git. A ruleset on GitHub without a file here is left
# alone. Usage: scripts/apply-rulesets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

for file in .github/rulesets/*.json; do
    name=$(jq -r .name "$file")
    id=$(gh api 'repos/{owner}/{repo}/rulesets' --jq ".[] | select(.name == \"$name\") | .id")
    if [ -n "$id" ]; then
        gh api --method PUT "repos/{owner}/{repo}/rulesets/$id" --input "$file" > /dev/null
        echo "updated ruleset $name ($id)"
    else
        id=$(gh api --method POST 'repos/{owner}/{repo}/rulesets' --input "$file" --jq .id)
        echo "created ruleset $name ($id)"
    fi
done
