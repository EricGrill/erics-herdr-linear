# Capture an idea, shape a ticket, start later

*Design record for [CHA-4200](https://linear.app/chainbytes/issue/CHA-4200).*

Approved proposal, 2026-11-03. Implementation tracked in CHA-4204 and CHA-4205 under CHA-4200. The sections below record the design rationale and acceptance criteria. See README.md for the implemented workflow and setup.

## Recommendation

Add a separate **Capture idea** entry beside the existing New task flow. One multiline field asks: "What would you like to improve?" Let the user type a rough thought, paste text or a URL, or use existing OS dictation. Show the current team and project as compact, editable context. Save a recoverable local draft before any remote operation. Target: capture in under 15 seconds, subject to usability testing.

Offer **Shape ticket** to produce an editable title, problem, desired outcome, proposed acceptance checks, and open questions. Preserve the original idea verbatim under Source idea. Suggested checks are proposals, never claims that the behavior exists or has been verified. Missing facts stay explicitly unknown. Ask at most one optional high-impact question at a time. A missing answer must not prevent saving the idea.

Primary action after review: **Create ticket**. Separate secondary action: **Start work**, available after creation and explicit execution-target selection. Collapsed details contain status, priority and assignee. Use compatible remembered team/project values, an actual backlog/triage state available on that team, no priority, and the current assignment default, visibly editable. Do not infer urgency, deadlines or ownership from emotional language.

## Four ideas, in order

1. **Quick capture and drafts:** highest-value first slice. Capture immediately without repository discovery or an installed agent. Save raw text with a suggested first-line title even if shaping is unavailable. Keep the existing New task path and repository validation intact.
2. **Assisted ticket shaping:** turn a short thought into a reviewable ticket. User-triggered only. Suggest title, problem, outcome and testable checks; show assumptions separately. The approved implementation uses the bounded provider contract recorded below. Never run the thought as a shell command or start a worktree merely to shape it.
3. **Screenshot plus one sentence:** explicitly select/paste an image and explain the problem. Link portable uploaded evidence to the ticket. Deferred to [CHA-4202](https://linear.app/chainbytes/issue/CHA-4202); see [screenshot-evidence.md](screenshot-evidence.md). The native feedback image helpers are frame-only; availability in this mod is unproven.
4. **Capture from anywhere:** user-invoked global entry and optional OS dictation feeding the same draft. Deferred to [CHA-4203](https://linear.app/chainbytes/issue/CHA-4203); discovery in [global-capture.md](global-capture.md). Verify shortcut support and preserve existing shortcuts before assigning a key.

## Sample ticket

Raw idea: "When I have an idea I just want to jot it down. I don't want to choose a computer or an agent yet."

Title: Capture an idea before choosing where work runs

Problem: The new-issue form asks for execution settings while the user is still capturing a thought.

Desired outcome: Save the idea and create a useful Linear ticket before choosing where or how to execute it.

Proposed acceptance checks:
- A nonempty idea can be saved as a local draft and recovered after the dialog closes or the app restarts.
- Ticket-only capture works with a valid team while repository and agent choices are absent.
- Original text survives shaping, edits, cancellation and failed requests.
- No capture or shaping action starts an agent, creates a worktree or changes a ticket to Done.
- Starting work later requires the existing validated computer/repository flow.

Open question: Should capture-only tickets default to unassigned or keep today's Me default? Proposed initial choice: preserve Me, make it visible, and allow changing it.

## Implementation boundary

Discovery evidence before implementation (line numbers refer to the original source):
- `mods/linear-workspace/client.js:955`: create resets text and supplies project/team defaults. There is no recoverable idea draft in this form.
- `mods/linear-workspace/client.js:1064` and the matching board client: submit validates an existing repository for both create actions and serializes the execution target. This is deliberate existing behavior, not a missing collapsed section.
- `mods/linear-workspace/api.js:135`: the underlying create operation can take title/team without an execution target. Optional description/project/state/priority/assignment already exist. It has no screenshot upload operation.
- `mods/linear-workspace/main.js:194`: afterCreate starts a worktree only when requested. `:394` renders the existing Create & start action.
- `mods/linear-workspace/look.js`: neutral surfaces, state colors, compact chips, native theme typography. The visual proposal follows this product language, not a new design system.
- Running app authority, `/Users/eric/.config/herdr-app/herdr.d.ts:314`: feedback image helpers are frame-only. They are not proof that this mod can capture screenshots.

Add a distinct capture-only submission mode in both client copies, rather than broadly removing execution validation. Keep launch gating and execution-target handling on existing paths. Capture-only tickets have no fabricated placement block. On Start work, resolve and validate an explicit target before persisting it. Cover the two clients with the same behavior tests. Installed copies and generated declarations remain deployment outputs.

Draft storage: namespace by Linear workspace and draft ID; keep original text, edited preview, context IDs and schema version. Restore only in the matching workspace. Persist locally before shaping or create, show save failures, and provide explicit discard. Do not store credentials or commit real ideas. Local retention and multi-window conflict handling need implementation decisions.

Shaping: no model service or credential path is established by this proposal. Define a bounded structured response, validate its schema, preserve unknowns, and apply it only if the draft revision still matches. Never overwrite edits with a late response. Keep a raw-ticket fallback if the model is unavailable. An existing agent installation does not prove safe, noninteractive structured generation support.

Create: disable duplicate submissions while in flight. Preserve the draft on errors. On an ambiguous network result, show "Creation not confirmed" and reconcile recent results before offering retry; exact duplicate prevention needs a verified server capability or a supported request marker, not a promise based on a disabled button. Once confirmed, retain the Linear ID so launch retries never create a second issue.

## Verification and stop condition

For implementation, use mocked Linear/model calls and sample text/images only:
1. Draft survives close/reopen, restart, offline use and shaping failure; workspace isolation and discard work.
2. Empty text is rejected; invalid team/project combinations are repaired visibly; stale shaping results cannot overwrite edits.
3. Capture-only creation needs no machine/repository/agent, preserves source text and makes exactly one mutation for repeated clicks.
4. Ambiguous create and failed launch retain the correct recovery state. Start work still validates the actual selected machine and repository. Both client copies behave consistently.
5. Run `npm test`, `npm run test:installer`, `npm run check`, each touched mod's `herdr-app check`, and inspect the native live layout with keyboard and narrow-window checks.

The proposal was approved for implementation in CHA-4204 and CHA-4205. Automated verification covers recoverable drafts, workspace isolation, stale revisions, editable shaping, create-only requests, and ambiguous/confirmed creation recovery. Final deployment evidence and remaining verification gaps are recorded on CHA-4200. The parent issue stays open for review.


## Verified shaping contract

The optional AI path uses a direct Responses request with no tools, a strict title/description schema, `store: false`, and local validation. It does not run a Codex subprocess or inherit an agent's hooks/integrations. The existing Herdr environment supplies `OPENAI_API_KEY`; no new dependency is installed. A basic local template is always available. API requests are user-invoked and bounded to 30 seconds. No live inference or credentials are used by automated checks.

Official references reviewed on 2026-11-03:
- [Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Tool selection](https://developers.openai.com/api/docs/guides/function-calling)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Provider data retention](https://developers.openai.com/api/docs/guides/your-data)
