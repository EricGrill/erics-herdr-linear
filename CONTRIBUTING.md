# Contributing

Thanks for looking. This is a personal layout kept public so other people can read it,
copy from it, or run it. Issues and pull requests are welcome; please read this first so
a change does not get stuck.

## Ground rules

- **This repository is the source of truth.** Installed copies under
  `~/.config/herdr-app` are deployment outputs. Edit sources here, verify, then install.
- **Don't change shipped Herdr mods or generated type files.** The native API authority is
  the running app's `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`.
  `mods/` folders adapted from upstream must keep their notices — see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **No new dependencies** unless they were asked for. The installer, updater and sync
  scripts are deliberately dependency-free.
- **Never commit credentials or screen state.** No API keys, OAuth tokens, `shared.json`,
  `view.json`, caches or `data/`. `npm run check` fails if machine-local state is in the
  checkout.
- **Keep changes narrow and reversible.**

## Before you open a pull request

```sh
npm test                 # mod unit tests
npm run test:installer   # installer tests
npm run check            # release structure, layout IDs, imports, SVGs, version match
```

Then run a native check on every mod you touched, and look at the live window:

```sh
herdr-app check mods/linear-board      # and each other mod you changed
```

A native check validates an initial render, not every later state. For UI changes, also
inspect the live Spaces view, Projects popup, Agents popup and the create/attach flows.

**Tests must not** call real Linear, read credentials, create live tickets, or start
agents. Public preview images use sample data only.

## Preview images

`preview.png`, `preview-dark.png` and `.github/social-preview.png` are generated from
[`scripts/preview/`](scripts/preview/), not screenshotted from a real workspace:

```sh
python3 scripts/preview/render.py
```

It needs Google Chrome and macOS `sips`, and nothing in the install, update or CI path
depends on it — the rendered PNGs are committed. Edit the HTML, re-render, and commit
both themes together so the light and dark images stay in sync.

## Versions

Don't bump the version in a pull request. Every merge to `main` that passes CI takes the
next patch version automatically and publishes it — see
[Keeping machines in sync](docs/multi-machine.md). For a minor or major release, set
`version` in `package.json` and the `sidebar-footer` version in
`layouts/erics-linear.json` together in the PR; `npm run check` enforces that they match.

## Commits

Use an intent-oriented [Conventional Commit](https://www.conventionalcommits.org/)
subject, plus the trailers that apply:

```text
feat: close finished spaces and group the sidebar by project

Tested: npm test, npm run check, herdr-app check mods/linear-board
Confidence: high
Scope-risk: sidebar grouping only
Not-tested: remote machine offline path
```

## Behaviour that is intentional

Please don't "fix" these without discussion — they are deliberate:

- **Linear workflow status is separate from agent activity.** An agent finishing does not
  close its ticket.
- Grouping is a view of work, not workflow automation.
- A merged pull request alone never auto-closes a space; it only puts it in Clean up.
- Publishing or tagging this repository is not proof of Herdr gallery discovery.
