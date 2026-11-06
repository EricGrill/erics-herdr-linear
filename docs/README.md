# Documentation

Start at the [README](../README.md) for what this layout is and how to install it.
[`RECIPE.md`](../RECIPE.md) is the gallery recipe: what the window looks like, how it
behaves, and what it is built from.

## Guides

How to use and run the layout.

| Page | What's in it |
| --- | --- |
| [What the layout does](features.md) | Every grouping, menu, panel and rule in the sidebar and issue header. |
| [Install](install.md) | Installer flags, what is backed up, what it never touches, and the install receipt. |
| [Create a task and choose where it runs](tasks.md) | New task, drafts, optional AI shaping, and how the execution computer and repository are resolved. |
| [Configuration](configuration.md) | The machine-local config file: Linear API key and Doppler fallback, attention rules, cleanup rules. |
| [Keeping machines in sync](multi-machine.md) | `update.sh`, the automatic updater, the `verified` branch and `deploy/<machine>` statuses. |
| [Agent permission modes](agent-permissions.md) | The per-agent unattended-launch mapping, version assumptions and policy limits. |

## Design records

Proposals and discovery notes kept for their rationale and acceptance criteria. They
describe intent at the time of writing, not necessarily today's behaviour — the guides
above are the current description.

| Page | Linear | What it covers |
| --- | --- | --- |
| [Capture an idea, shape a ticket, start later](idea-capture.md) | [CHA-4200](https://linear.app/chainbytes/issue/CHA-4200) | Approved proposal behind idea capture and ticket shaping. |
| [Screenshot evidence for idea capture](screenshot-evidence.md) | [CHA-4202](https://linear.app/chainbytes/issue/CHA-4202) | Design only: attaching a screenshot and getting a Linear-hosted copy instead of a local path. |
| [Capture an idea from outside Herdr](global-capture.md) | [CHA-4203](https://linear.app/chainbytes/issue/CHA-4203) | Discovery for a global capture entry point and dictation feeding the same draft. |
| [One New task flow](new-task-flow.md) | [CHA-4219](https://linear.app/chainbytes/issue/CHA-4219) | Merging New task and Capture idea into a single multiline request. |
| [Keep remote worktree preparation alive](remote-worktree-jobs.md) | [CHA-4248](https://linear.app/chainbytes/issue/CHA-4248) | Why detached remote worktree workers failed to start, and the fix. |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the checks every change has to pass, and
[SECURITY.md](../SECURITY.md) for how to report something sensitive.
