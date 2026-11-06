# Agent permission modes

*Design record for [CHA-4235](https://linear.app/chainbytes/issue/CHA-4235).*

Both Linear mods prepare unattended launch arguments for new workspaces and additional
agent tabs in existing workspaces. The selected computer still discovers its own agent
command. Launch preparation copies that command without changing the discovery data or
writing global agent settings. Other/custom agent keys keep their original arguments.

| Herdr agent | Launch policy | Authority |
| --- | --- | --- |
| Codex | `--yolo`, preserving its long bypass alias | Installed `codex --yolo --help` |
| Claude Code | `--dangerously-skip-permissions` | Installed `claude --help` |
| Cursor | `--force`, preserving `-f` or `--yolo`; remove conflicting `--auto-review` | [Cursor parameters](https://cursor.com/docs/cli/reference/parameters), installed bundled option definitions |
| Kimi | `--auto`; replace older yolo aliases; prompt mode is already unattended. Kimi takes no positional prompt, so a first message runs as `kimi -p` through `sh`, then the session resumes with `--auto --continue` (CHA-4284) | [Kimi command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html), installed `kimi --help` |
| Gemini | `--approval-mode=yolo`; replace conflicting approval modes and yolo aliases | [Gemini configuration](https://geminicli.com/docs/reference/configuration/), installed `gemini --help` |
| Copilot | `--allow-all`, preserving `--yolo` | [Copilot tool permissions](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools) |
| Grok | `--always-approve`; replace conflicting permission modes | [Grok permissions](https://docs.x.ai/build/features/permissions), installed `grok --help` |
| Antigravity | `--dangerously-skip-permissions` | [Antigravity CLI](https://antigravity.google/docs/cli-using), installed `agy --help` |
| Hermes | `--yolo` | [Hermes security](https://hermes-agent.nousresearch.com/docs/user-guide/security/), installed `hermes --help` |
| Qoder | `--yolo`, preserving `--dangerously-skip-permissions` | [Qoder CLI reference](https://docs.qoder.com/cli/cli-reference) |
| Crush | `--yolo`, preserving `-y` | [Crush upstream](https://github.com/charmbracelet/crush) |
| Kiro | `chat --trust-all-tools` | [Kiro CLI commands](https://kiro.dev/docs/reference/cli-commands/) |
| OpenCode | `env 'OPENCODE_PERMISSION={"*":"allow"}'` before the discovered command | [OpenCode environment](https://opencode.ai/docs/cli/), [permission schema](https://opencode.ai/docs/permissions/) |
| Pi / PiG | Default tool execution, no extra flag | [Pi permissions](https://github.com/earendil-works/pi#permissions--containerization), [PiG security](https://pigagent.dev/docs/latest/security) |
| Amp | Current default tool execution, no obsolete bypass flag | [Amp rebuild](https://ampcode.com/news/neo), installed `amp --help` |

## Compatibility and verification

Checked against the running Herdr catalog, installed help, and upstream documentation
on 2026-11-04. Current Kimi Code's `--yolo` is Ask When Needed, so full unattended
execution requires `--auto`. Older Kimi CLI installations may require an upgrade.
The installed OpenCode has no `--auto` option; its documented process environment
provides the compatible override instead.

OpenCode's isolated `debug config` and `debug agent build` checks used temporary
configuration with `bash: ask` and `edit: deny`. The environment override added a final
wildcard allow rule after those rules in the resolved default build agent permissions.
No inference session was started. Explicit per-agent policies and custom wrappers can
still affect the resulting behavior.

Tests cover all catalog mappings across local and remote new-workspace launches and
additional agent tabs. They check custom arguments, alias handling, conflicting modes,
command routing, and unmodified discovery data. CLI help and configuration inspection
do not prove a live session can authenticate or that an older remote CLI accepts new
options. Organization policies, extensions, explicit denials, and first-launch trust
prompts may still apply. Pi/PiG project trust and custom Amp permission plugins are
separate from their default tool execution behavior.

Already-running agents retain their original settings. Shipped Herdr menus and global
agent configuration are outside this Linear launch policy.
