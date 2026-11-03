#!/usr/bin/env bash
# Original update tooling for Eric's Herdr Linear. MIT; see ../LICENSE.
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
if [[ $(git -C "$repo_dir" rev-parse --show-toplevel) != "$repo_dir" ]]; then
  echo "Run this from a Git checkout of Eric's Herdr Linear." >&2
  exit 1
fi
if [[ -n $(git -C "$repo_dir" status --porcelain) ]]; then
  echo "Checkout has local changes. Commit or resolve them before updating; nothing was discarded." >&2
  exit 1
fi
if [[ -z $(git -C "$repo_dir" branch --show-current) ]]; then
  echo "Checkout is detached. Select a tracking branch before updating." >&2
  exit 1
fi
git -C "$repo_dir" pull --ff-only
python3 "$repo_dir/scripts/install.py" --update "$@"
