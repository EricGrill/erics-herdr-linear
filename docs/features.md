# What the layout does

The full behaviour of the sidebar, groups, menus and panels. The
[README](../README.md) has the short version.


- Puts work needing attention before finished, working, and idle spaces.
- Shows each space's Linear ticket and machine. Click a space to return to its terminal.
- Gives each machine its own colored dot, the same after every restart, and says when a
  remote machine is offline or reconnecting, on its rows and under Add machine.
- Keeps the current group's header (Needs you, Done, Working, Idle) pinned while you scroll.
- **By status / By project** switches the sidebar between state groups and one group per
  Linear project (projects that need you first, spaces without a project last). Click any
  group header to collapse it; the choice and collapsed groups are remembered.
- **Clean up (N)** appears when spaces are finished: their ticket is Done or Canceled in
  Linear, or their pull request merged. It lists each with what its checkout holds and
  closes the picked ones at once, optionally removing clean worktree checkouts with
  `git worktree remove` (never forced, so uncommitted edits block it; the branch is kept).
- Auto-close: a space whose ticket has been Done or Canceled for 10 minutes closes by
  itself, unless it is the space you are in, pinned, has an agent working or waiting, or
  has uncommitted edits. Only the space closes; its ticket, folder and branch stay.
- Shows the Needs you count beside Erics Linear in the window header, even with the
  sidebar collapsed. It hides at zero.
- Right-click a space for its menu: with a Linear ticket, Open in Linear app, Open in
  browser and Copy link come first, then Rename, New/Open worktree, Close. Without a ticket,
  Herdr's own space menu. Right-click a tab for Rename, New tab, Close. Closing a space does
  not change its Linear ticket.
- Pin, tag and color spaces with Linear labels, so they are the same on every machine.
  Right-click a space or issue for **Pin to top**/**Unpin** and **Tags…**. Pinning adds the
  workspace label `Pinned` (made on first use); pinned spaces show under PINNED above the
  other groups and keep their own state line. **Tags…** lists the workspace's and the
  issue's team's labels, leaving out routing labels (`agent:`, `repo:`, …) and label
  groups; typing a new name offers **Create tag**. A row shows up to two tags as chips in
  their Linear colors, and a stripe in its first tag's color. Recolor a tag in Linear.
  Each change adds or removes one label and is read back from Linear before it shows.
- Right-click an issue (Projects rows, the issue panel, the task dialog's list and issue
  screen, Crew) for Open in Linear app, Open in browser, Copy link. The app link is the
  web link under `linear://`; it needs the Linear desktop app on this computer.
- Keeps the full project tree in a separate popup, with search and task creation.
- Shows live Herdr agents in a scrollable popup, including remote agents and subagents.
- Shows each Linear agent's full open issue queue in Crew, with attention reasons, issue
  inspection and verified reassignment, without treating a delegated ticket as a running agent.
- Creates a ticket before starting a task in its worktree, or attaches an existing space
  to a ticket without moving its files or changing its branch.
- Lets you choose the execution computer, then an existing Git repository under that
  computer's `~/code`, instead of using a local-only folder picker.
- Retains Herdr's terminal tabs, pane controls, Files and Changes.
- The issue header reads status · priority · delegate or assignee · pull request and
  checks · lines added/removed. The status bar shows the machine, commits ahead/behind,
  uncommitted changes and how long the agent has been working, for local and remote
  worktrees alike; the branch is in its hover text. Fields with no value are left out.

The grouping is a view of work, not a workflow automation. Finishing an agent run does
not mark a Linear ticket Done. Commands typed directly into a terminal can still start
unlinked work; the issue header identifies spaces that have no ticket.
