#!/usr/bin/env bash
# Original explicit SSH sync tooling for Eric's Herdr Linear. MIT; see ../LICENSE.
set -euo pipefail

select_layout=no
if [[ ${1:-} == --select ]]; then
  select_layout=yes
  shift
fi
if [[ $# -eq 0 ]]; then
  echo "Usage: bash scripts/sync.sh [--select] SSH_HOST..." >&2
  exit 2
fi
for target_host in "$@"; do
  if [[ ! $target_host =~ ^[a-zA-Z0-9_.@-]+$ || $target_host == -* ]]; then
    echo "Use a plain SSH host name: $target_host" >&2
    exit 2
  fi
  echo "Syncing Eric's Herdr Linear to $target_host"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$target_host" sh -s -- "$select_layout" <<'REMOTE'
set -eu
select_layout=$1
repo_dir="$HOME/code/erics-herdr-linear"
expected='https://github.com/EricGrill/erics-herdr-linear.git'
if test -e "$repo_dir"; then
  test -d "$repo_dir/.git" || { echo "Target path is not the expected Git checkout." >&2; exit 1; }
  origin=$(git -C "$repo_dir" remote get-url origin)
  case "$origin" in
    https://github.com/EricGrill/erics-herdr-linear|https://github.com/EricGrill/erics-herdr-linear.git|git@github.com:EricGrill/erics-herdr-linear.git) ;;
    *) echo "Target checkout has a different origin; refusing to replace it." >&2; exit 1 ;;
  esac
  test -z "$(git -C "$repo_dir" status --porcelain)" || { echo "Target checkout has local changes; nothing was discarded." >&2; exit 1; }
  test -n "$(git -C "$repo_dir" branch --show-current)" || { echo "Target checkout is detached." >&2; exit 1; }
  git -C "$repo_dir" pull --ff-only
else
  mkdir -p "$HOME/code"
  git clone "$expected" "$repo_dir"
fi
if test "$select_layout" = yes; then
  python3 "$repo_dir/scripts/install.py" --update --select
else
  python3 "$repo_dir/scripts/install.py" --update
fi
REMOTE
done
