# CHA-4370: delegating to Linear agents from the layout

Linear agents could already be *seen* in this layout: Crew listed every agent identity in
the workspace with its full open delegated queue, and work could be moved from one agent
to another. What was missing was the first step. An issue no agent had yet appeared in no
Crew list, and the issue's agent panel said to go and delegate it in Linear. Delegating
was the one part of the loop that left Herdr.

This adds the missing direction: hand a ticket to a Linear agent from inside the layout,
on the same verified write Crew already used for a move.

## The two places it is reachable from

**The issue's agent panel** (Cmd+Shift+A / Alt+Shift+D) acts on the ticket in the open
workspace. **Delegate…** appears when no agent has it, **Change agent…** when one does.
Choosing an agent and confirming writes the delegate and reads it back.

The control follows the ticket, never the Spaces delegate filter. The panel's heading
falls back to that filter when the ticket has no agent, so a filtered view must not read
as the ticket having one.

**Crew** gains a **Not delegated** row above the agents: every open issue the workspace
read shows with no delegate, attention first, selectable one at a time or in bulk. It is
a bucket, not an agent. It is left out of the agent count, and it can never be a
destination, because an issue cannot be delegated to nobody.

## Where its rows come from

The bucket reads from the bulk enrichment, not from a per-agent queue query: "no
delegate" is not a delegate to filter by, and the enrichment already reads every open
issue in the workspace. Three scalars were added to that query — `title`, `url` and
`priorityLabel` — so an undelegated row can be drawn, right-clicked and opened without a
second read.

The bucket is therefore exactly as complete as the enrichment is. A partial or failed
read shows the count as `N+` with the reason, instead of implying an exact number. An
agent's own queue is still read per agent and is unaffected.

## What the write does, and what it does not

One field, `delegateId`, through the existing `reassignIssue`: read the issue, send only
the delegate, read it back, and confirm the delegate landed while the human assignee,
workflow state, project and priority did not move. A bulk handoff writes one issue at a
time and reports each result; failures stay selected so the same button retries them.

Delegating starts nothing here. Linear runs the agent. Herdr sends no command, opens no
terminal and creates no worktree, and a session already running on that ticket keeps
running on it. Wording distinguishes the two cases on purpose: a first handoff is
"Delegated", moving work off another agent is "Moved".

A confirmed write republishes the enrichment at once, so the delegate chip, the **Agent**
grouping and Crew all show the new agent without waiting for the sidebar's next refresh.

## Verification

`npm test` (778), `npm run test:installer` (45), `npm run check`, and
`herdr-app check mods/linear-board`. Tests cover the bucket's membership and lower-bound
counts, the verbs, both surfaces end to end, a refused write, a missing Linear
connection, and the absence of any terminal effect. No test calls Linear, reads a
credential, creates a ticket or starts an agent.

Not covered by tests: Linear's own behaviour on receiving a delegation. That an agent
picks the issue up, and how long it takes, is Linear's side of the handoff. Delegating
does not change the issue's workflow status, and an agent finishing does not close its
ticket.
