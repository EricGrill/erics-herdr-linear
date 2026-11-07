# Create a task and choose where it runs

How **New issue** / **New task** works, what it remembers, and how the execution
computer and repository are resolved.

## Create a task or capture an idea


Choose **New issue** from the issue list, a project, or the launcher. Write the request in
one multiline field, then **Create issue**. The first nonempty request line supplies
the ticket title; the full request is retained as its description. The current task's project
and repository, or your previous compatible choices, are prefilled and editable.
Status, priority and assignment are remembered from the previous successful task and
remain available under **Ticket details**. Repository choices stay scoped to the
Linear workspace, project and computer. Existing capture commands and shortcuts open
the same form.

New task saves a local draft as you type, scoped to the selected Linear workspace in
that mod, using a stable persisted app key across dialog instances.
Closing the dialog or restarting Herdr restores it, including the selected
repository. **Discard draft** removes it explicitly. Storage failures and conflicting
revisions are shown instead of silently replacing another window's draft. Drafts remain
local to this app and are not synced between computers or the two mods. Existing idea
drafts open in this form with their original source preserved.

**Improve with AI** is optional. It sends the source idea, or the entered request, to OpenAI for editable suggestions. It uses the existing `gpt-6-luna`
Responses integration with tools disabled and `store: false`; this does not disable all
provider retention. It requires `OPENAI_API_KEY` in the Herdr process environment and
uses the account's API billing. Keys are not placed in preferences or command arguments.
No agent session or worktree is started for shaping. Without a key or on failure, the
local draft and direct creation remain available. Shaped tickets preserve their source
idea; its **Edit source idea** control also offers the existing local **Shape ticket**
template.

**Create issue** validates and saves the selected repository with the ticket. A task can
also be created without a repository, then assigned one later. **Create & start** requires
an installed agent. Without a chosen repository it first makes a new one (see below); its
validated target and submitted text are carried through to that launch. A failed or unconfirmed create retains the draft
and asks you to check recent issues before retrying, since a lost response can follow a
successful write. Finishing a task creation or agent run does not mark an issue Done.

## Choose where a task runs

In New task, write the request in **What needs doing?**. The title uses the first
line, shortened to 100 characters; the full text is saved as the description.
**Ticket details** lets you change the remembered status, priority and assignee.
Team and project remain editable. These choices are remembered per Linear workspace;
a removed or completed status falls back to an available open status.

Select **Computer**. A matching repository is selected automatically from that
computer's own `~/code`, using the project name first, then the focused repository's
name (including Herdr worktrees). This also works after switching computers, without
choosing a local storage path. Use **Repository** to override the default. It never
clones. **New repository** is the fallback when no name matches:
when no repository is chosen, **Start agent** and **Create & start** make a new Git
repository in that computer's `~/code`, named from the ticket title (a taken name gets
`-2`, `-3`, …), with an empty initial commit so the worktree can branch from it. That
repository is also marked trusted in the computer's Claude Code config (`~/.claude.json`), so
Claude doesn't ask to trust it. Claude's trust stops at each Git repository, so trusting `~/code`
alone isn't enough. Without `python3` or a Claude config, this step is skipped. Plain
**Create issue** makes nothing. A ticket whose saved computer cannot be resolved stays
blocked rather than falling back to a new repository.
Linear's **Start agent**, **Create & start**, and additional agent tabs use each supported
agent's unattended permission mode on the selected computer. This includes Cursor's
`--force` and current Kimi Code's `--auto`, alongside Codex and Claude Code.
Pi, PiG, and current Amp already execute tools without built-in approval prompts.
See [agent permission modes](agent-permissions.md) for the complete mapping,
version assumptions, and policy limits. Existing sessions retain their launch settings.

Installed-agent choices are refreshed for that computer. Changing computers clears
stale repository and agent choices, and unavailable computers cannot be used.
New tasks remember the last project selected or visited in each Linear workspace.
An explicit repository choice overrides the name default and saves that project's
computer and repository for future tasks
(or the workspace's choice when no project is selected),
with separate repository choices for each computer. Agent selections are also remembered
for each computer. These preferences persist in this
Herdr app and are shared by both Linear layouts. A missing saved repository stays
unselected; choose one, or Start makes a new one.
The pinned worktree backend trims path output, so paths containing newlines or ending
in whitespace are rejected before any ticket or worktree mutation.

Both **Create issue** and **Create & start** validate the existing repository. Queued
issues retain their selected execution target. Starting work may create the issue's
worktree inside that existing repository; the base repository must already exist.
An owned JSON block in the issue description records the computer's stable Herdr
identity and repository path, so another client can resolve the same physical target.
It contains placement metadata, not credentials.

Choosing **This computer** explicitly targets the local machine even while a remote
space is focused. A saved target that cannot be resolved must be chosen explicitly;
the launcher must not silently substitute a different computer.
Launch actions, including keyboard shortcuts, are gated until the issue's saved
placement is ready. Create & start retains its validated request target while the
new issue's details load.

