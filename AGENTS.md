# Eric's Herdr Linear

This repository is the source of truth for a personal/community Herdr layout. Edit sources
here, verify, commit and push, then install to each machine. Installed copies under
`~/.config/herdr-app` are deployment outputs. Do not copy screen state or credentials into Git.

- `layouts/erics-linear.json`: native GPUI layout, not HTML/CSS.
- `mods/linear-board`: Spaces-first sidebar, Projects popup, Crew and issue/delegate panels.
- Other `mods/` folders are required adapted interface components; preserve upstream notices.
- `scripts/`: dependency-free local install, explicit update and named-host sync.
- `erics-linear.config.json` belongs in the machine's Herdr home and is deliberately ignored.

Do not change shipped Herdr mods or generated type files. Native API authority is the
running app's `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts`, and `gpui-kit.d.ts`.
Preserve per-machine settings, credentials, global shortcuts and terminal state during installs.
No new dependencies unless the user requests them. Keep changes narrow and reversible.

Run `npm test`, `npm run test:installer`, and `npm run check`. Run `herdr-app check` on each
touched mod and inspect the live layout after UI changes. Tests must not call real Linear,
read credentials, create live tickets, or start agents. Public preview images use sample data.

Keep Linear workflow status distinct from agent activity. An agent finishing does not
close its ticket. Publishing the repo or tagging it is not proof of Herdr gallery discovery.

Commits use an intent-oriented Conventional Commit subject and relevant Lore trailers,
such as `Tested:`, `Confidence:`, `Scope-risk:`, and `Not-tested:`.
