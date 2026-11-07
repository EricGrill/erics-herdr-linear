# Keeping machines in sync

How a change travels from this repository to each machine, and how to turn the automatic
updater on, off, or inspect it.


Treat this repository as the source of truth. Make changes in the checkout, test them,
commit, and push. Installing copies files into Herdr; editing the installed copy does not
automatically edit or push the repository.

On each machine, clone this repo once and install it. To receive a published update from
that checkout:

```sh
bash scripts/update.sh
```

The updater uses a fast-forward Git pull and then installs the checked-out version. A
dirty or divergent checkout needs to be resolved rather than discarded.

### Automatic updates on merge to main

When a push to `main` passes CI (`npm test`, `npm run test:installer`, `npm run check`),
CI raises the patch version (0.1.1 → 0.1.2) in `package.json` and the sidebar footer
together, commits that to `main` as `chore: release v<version>`, fast-forwards the
`verified` branch to the release commit and marks each machine as a pending
`deploy/<machine>` commit status. Turn on the updater once per machine, from its checkout:

```sh
python3 scripts/auto_update.py install --machine snoke   # omarchy2, snoke, ventress
```

This adds a launchd agent on macOS or a systemd user timer on Linux. Every five minutes
(and after login or wake) it fetches `verified` and, when that moved, runs
`scripts/update.sh --to <commit>`: a fast-forward to exactly the verified commit, then
`install.py --update`, with `--select` only if the Herdr window is open. It then sets the
commit's `deploy/<machine>` status to the installed sidebar version and commit, using
the machine's existing `gh` sign-in, and shows a desktop notification.

Nothing is overwritten. A checkout with local changes, not on `main`, or with commits
that are not on `verified` is skipped and reported as a failed status and a notification,
once per commit. A failed install is reported once and retried after 15 minutes, 1 hour,
4 hours, then daily, without `--select` if it failed while selecting; a new `verified`
commit is tried at once, and `python3 scripts/auto_update.py run --now` retries
immediately. A sleeping or offline machine stays pending on GitHub and catches up on
its next run; if it cannot reach GitHub for a day it says so. Check a machine with
`python3 scripts/auto_update.py status`; turn it off with `... uninstall`. The log is in
`~/.local/state/erics-herdr-linear/auto-update.log`. The machine list for pending
statuses is `MACHINES` in [`.github/workflows/verify.yml`](../.github/workflows/verify.yml).

Every deploy gets the next patch version automatically, so don't bump it in a PR. For a
minor or major release, set `version` in `package.json` and the `sidebar-footer` version
in `layouts/erics-linear.json` together in the PR (`npm run check` enforces it); CI then
releases that version as it is. `python3 scripts/bump_version.py` does the patch bump by hand.

From a machine with SSH access to your other computers, explicitly sync named targets:

```sh
bash scripts/sync.sh linux-desktop mac-mini
```

Add `--select` before the host names to select and verify the layout remotely. Sync uses
`~/code/erics-herdr-linear` on each target, verifies an existing checkout's origin, and
refuses dirty or detached checkouts. SSH and Git authentication are handled by your own
configuration. No credentials are copied.

Each machine keeps its own credentials, settings, window/terminal state, and
`erics-linear.config.json`. Updating the code does not share the workspaces themselves;
Herdr's machine connections determine which remote spaces are visible.

