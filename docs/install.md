# Install

The [README quickstart](../README.md#quickstart) covers the common case. This page has
the flags, what the installer backs up, and what it never touches.

The layout ID is `erics-linear`; its window header reads **Erics Linear**. The expanded
sidebar shows **Layout v<version>** beside Settings, taken from this repository's
`package.json`. CI raises it with every deploy (see
[Keeping machines in sync](multi-machine.md)), and `npm run check` verifies that the
sidebar-footer version in `layouts/erics-linear.json` matches.


Install and open Herdr once first. This layout has been exercised with **Herdr 0.1.13** on
macOS and Linux. It uses Python 3.8+ for installation, Git for updates, and Node.js for the
optional test suite. The Linear adapter uses `curl`, `tar`, and a SHA-256 utility to obtain
its platform-specific backend if it is not already installed.

```sh
git clone https://github.com/EricGrill/erics-herdr-linear.git
cd erics-herdr-linear
python3 scripts/install.py
```

Use `--dry-run` to inspect the plan, `--update` to replace a previous installation with a
backup, or `--select` to select the layout and verify that Herdr confirms it. `--home PATH`
targets another Herdr configuration folder. `--config PATH` explicitly replaces the
machine-local non-secret preferences file before source updates; omitting it preserves
that file. Shortcut conflicts are reported rather than silently overwritten.

Select **erics-linear** in **Herdr Settings → Look**, or run this in a shell where Herdr's
CLI is available:

```sh
herdr-app do layout.switch --name erics-linear
```

Review the [recipe](../RECIPE.md) and source before installing. These are trusted native mods:
they run commands through Herdr, read machine-local configuration and Linear sign-in
state, make Linear API requests, and can create worktrees or launch agents when you use
those actions. They do not include your account credentials or another person's screen
state.

The installer copies the custom layout and its five mods. It merges only this layout's
shortcut section; it does not replace your global keyboard settings, terminal sessions,
window geometry, or account state. Existing files are backed up before an update. A
local `.erics-linear-install.json` receipt records the source checkout, Git commit,
installed-file hashes, and check/selection results. If Herdr's CLI is unavailable, the
installer reports that native checks did not run; it cannot claim selection. Keep
your machine-local configuration outside this Git checkout.

