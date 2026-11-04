#!/usr/bin/env bash
# Original update tooling for Eric's Herdr Linear. MIT; see ../LICENSE.
# Usage: bash scripts/update.sh [--to COMMIT] [install.py options, e.g. --select]
# --to fast-forwards to that exact commit (already fetched) instead of pulling, so the
# automatic updater installs the commit CI verified even if main has moved since.
set -euo pipefail

target=
if [[ ${1:-} == --to ]]; then
  target=${2:?--to needs a commit}
  shift 2
fi

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
if [[ -n $target ]]; then
  git -C "$repo_dir" merge --ff-only --quiet "$target"
else
  git -C "$repo_dir" pull --ff-only
fi
python3 "$repo_dir/scripts/install.py" --update "$@"
