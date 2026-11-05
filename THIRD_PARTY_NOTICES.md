# Third-party notices

Eric's Herdr Linear is an independent community layout. Its original contributions are
licensed under the root [MIT license](LICENSE). That license does not replace the
licenses of copied upstream material listed below. Existing upstream notices in source
files must remain intact.

## Herdr app

- Source: [herdrdev/herdr-app](https://github.com/herdrdev/herdr-app)
- Upstream license: [Apache License 2.0](https://github.com/herdrdev/herdr-app/blob/v0.1.12/LICENSE)
- Full license copy: [licenses/herdr-app-Apache-2.0.txt](licenses/herdr-app-Apache-2.0.txt)

The following are copies or adaptations of Herdr's shipped interface components:

| This repository | Upstream component | Local modifications |
| --- | --- | --- |
| `mods/erics-linear-agents/` | `defaults/mods/agents/` | Agent popup sizing, title/shortcut hint, popup-aware compact mode, close-on-selection |
| `mods/erics-linear-chrome/` | `defaults/mods/workspace-chrome/` | Erics Linear branding and cloned asset paths |
| `mods/linear-workspace-tabs/` | `defaults/mods/tabs/` | Ticket-based plus-menu launcher and cloned asset paths |
| `mods/linear-board/main.js` (`status` role) | `defaults/mods/workspace-status/` | Status bar shows git ahead/behind, uncommitted changes and agent running time; branch moved to hover text |
| `layouts/erics-linear.json` | `defaults/layouts/main.json` | Spaces-first sidebar, custom context header, custom mods and issue/delegate panels |

These upstream portions remain subject to Apache-2.0. Modification notices and
`cloned_from` provenance identify the adapted files. Herdr itself, its native runtime,
bundled fonts, terminal engine, and compiled dependencies are not distributed by this
repository. They are supplied by the user's Herdr installation. Herdr's broader
[third-party notices](https://github.com/herdrdev/herdr-app/blob/master/THIRD-PARTY-NOTICES)
apply to the corresponding upstream distribution.

## herdr-linear

- Source: [mrolafsson/herdr-linear](https://github.com/mrolafsson/herdr-linear)
- Upstream license: [MIT](https://github.com/mrolafsson/herdr-linear/blob/v0.14.2/LICENSE)
- Copyright notice: **Copyright (c) 2026 Hjortur Stefan Olafsson**
- Full license copy: [licenses/herdr-linear-MIT.txt](licenses/herdr-linear-MIT.txt)

`client.js`, `look.js`, the Linear icon sets, and associated original mod material in
`mods/linear-workspace/` and `mods/linear-board/` come from the herdr-linear app mod.
The client has been adapted for persistent layouts, ticket context on reopened worktrees,
explicit installed-agent selection, and create/start validation. Those portions retain
the upstream MIT notice and permission terms. The full upstream license accompanies this
distribution.

The backend executable is not committed here. The adapter obtains the pinned **0.14.2**
release from the upstream project's GitHub releases, verifies its release checksum, and
uses the user's machine-local sign-in. A reference to the backend does not bundle its
executable or the user's account state.

## Lucide and Feather icons

Herdr's shipped mod glyphs include Lucide SVGs, including the copied `check.svg` and
related chrome glyphs. Lucide uses ISC; listed icons derived from Feather retain the
Feather MIT notice. The exact combined notices supplied with Herdr **v0.1.12** are
included in [licenses/herdr-Lucide-ISC.txt](licenses/herdr-Lucide-ISC.txt), preserving:

- **Copyright (c) 2026 Lucide Icons and Contributors**
- **Copyright (c) 2013-present Cole Bemis** for the Feather-derived icons listed there.

Sources: [Herdr's pinned icon attribution](https://github.com/herdrdev/herdr-app/blob/v0.1.12/defaults/icons/LICENSES.md),
[full Lucide/Feather notices](https://github.com/herdrdev/herdr-app/blob/v0.1.12/defaults/icons/LICENSE-Lucide.txt).
Agent-brand pictures and fonts are provided by the installed Herdr app rather than
copied into this repository.

## New work and attribution

The spaces-first queue, project/crew composition, configurable enrichment and attention
preferences, installation/update tooling, tests added for this project, documentation,
and demonstration preview contain Eric's Herdr Linear contributions. The root MIT grant
applies to those original contributions, subject to the retained upstream terms for
material they adapt. Do not remove an upstream notice when changing a copied file.

Herdr and Linear names identify integrations and provenance. No upstream endorsement is
claimed.
