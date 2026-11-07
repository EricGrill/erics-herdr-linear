# Security

## What this layout can reach

These are trusted native Herdr mods. When you use the relevant actions they:

- run commands through Herdr, including on configured remote machines;
- read machine-local configuration and Linear sign-in state;
- make Linear API requests with your key or OAuth session;
- create Git worktrees and launch coding agents in **unattended permission mode**.

They do **not** bundle credentials. The machine-local config file
(`~/.config/herdr-app/erics-linear.config.json`) holds **key names, never key values**,
and is deliberately kept out of Git. Credential values stay inside the shell that sends
the request and are never written to layout preferences or command arguments.

Review [`RECIPE.md`](RECIPE.md) and the source before installing, and read
[agent permission modes](docs/agent-permissions.md) before letting agents run unattended
on a machine you care about.

## Supported versions

Only the latest release is supported. Each machine's updater installs the most recent
`verified` commit; see [Keeping machines in sync](docs/multi-machine.md).

## Reporting a vulnerability

Please **do not open a public issue** for anything that could expose credentials, reach a
machine, or execute code.

Use GitHub's private reporting instead:
**[Report a vulnerability](https://github.com/EricGrill/erics-herdr-linear/security/advisories/new)**.

Include what you did, what happened, and which Herdr and layout versions you were on.
This is a personal project, so expect a reply in days rather than hours. If it is
genuinely exploitable, please give it a reasonable window before writing it up publicly.

When you report, leave out real API keys, tokens, ticket contents and screenshots of
private work — a redacted reproduction is enough.
