#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Project516
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

upstream=nicotine-plus/nicotine-plus
pin=.github/upstream-release
mapfile -t current < "$pin"
tag=$(gh api "repos/$upstream/releases/latest" --jq .tag_name)
git check-ref-format "refs/tags/$tag"

git fetch --no-tags "https://github.com/$upstream.git" \
  "+refs/tags/$tag:refs/upstream/latest" \
  "+refs/tags/${current[0]}:refs/upstream/current"
previous=$(git rev-parse 'refs/upstream/current^{commit}')
if [[ $previous != "${current[1]}" ]]; then
  echo "::error::Upstream moved the pinned tag ${current[0]}."
  exit 1
fi
latest=$(git rev-parse 'refs/upstream/latest^{commit}')
if [[ $tag == "${current[0]}" ]]; then
  echo "master already tracks Nicotine+ $tag."
  exit 0
fi
branch="sync/nicotine-plus-$tag"
if [[ $(gh pr list --state open --head "$branch" --json number --jq length) != 0 ]]; then
  echo "A pull request for Nicotine+ $tag is already open."
  exit 0
fi

# The pin supplies the merge base even after the sync PR is squash-merged.
status=0
result=$(git merge-tree --write-tree --name-only --no-messages \
  --merge-base="$previous" HEAD "$latest") || status=$?
if (( status > 1 )); then
  exit "$status"
fi
tree=${result%%$'\n'*}
if (( status == 1 )); then
  conflicts=$(printf '%s\n' "$result" | tail -n +2 | sed '/^$/d; /^README\.md$/d')
  if [[ -n $conflicts ]]; then
    title="Nicotine+ $tag needs a manual sync"
    issue=$(gh issue list --state open --search "$title in:title" --json number,title \
      | jq -r --arg title "$title" 'first(.[] | select(.title == $title) | .number) // empty')
    {
      printf 'Sync [Nicotine+ %s](https://github.com/%s/releases/tag/%s) using %s as the merge base. Update %s once the conflicts are resolved.\n\n' \
        "$tag" "$upstream" "$tag" "${current[0]}" "$pin"
      printf '%s\n' 'Conflicting files:' '' '```' "$conflicts" '```'
    } > "$RUNNER_TEMP/upstream-conflict.md"
    if [[ -n $issue ]]; then
      gh issue edit "$issue" --body-file "$RUNNER_TEMP/upstream-conflict.md"
    else
      gh issue create --title "$title" --body-file "$RUNNER_TEMP/upstream-conflict.md"
    fi
    echo "::error::Nicotine+ $tag needs a manual sync."
    exit 1
  fi
fi

git read-tree --reset -u "$tree"
git restore --source=HEAD --staged --worktree README.md
printf '%s\n' "$tag" "$latest" > "$pin"
git add "$pin"
git -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -m "chore(sync): update Nicotine+ to $tag"
printf 'tag=%s\nbranch=%s\n' "$tag" "$branch" >> "$GITHUB_OUTPUT"
