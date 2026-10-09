#!/usr/bin/env bash
# Applies .github/repository.json (description, homepage, topics) to this
# repository's GitHub remote and prints what GitHub holds afterwards, so these
# settings live in git like the rulesets. Needs gh with repository
# administration on the remote. Usage: scripts/apply-repo-settings.sh
set -euo pipefail
cd "$(dirname "$0")/.."

settings=.github/repository.json
jq -c '{description, homepage}' "$settings" | gh api --method PATCH 'repos/{owner}/{repo}' --input - > /dev/null
jq -c '{names: .topics}' "$settings" | gh api --method PUT 'repos/{owner}/{repo}/topics' --input - > /dev/null
gh repo view --json description,homepageUrl,repositoryTopics \
    --jq '"description: \(.description)\nhomepage: \(.homepageUrl)\ntopics: \((.repositoryTopics // []) | map(.name) | join(", "))"'
