# CHA-4219: One New task flow

Replace the separate New task and Capture idea controls with New task. Open directly
on one multiline request, deriving a short title while retaining the full text.
Keep the single-request behavior merged in CHA-4217, with team, project and repository filled
from the current task or remembered choices. Keep status, priority and assignment
editable. Shaping stays optional; it must never be required to create a task.

Reuse the recoverable draft and ambiguous-create reconciliation path. Preserve old
idea drafts and their original source text. Carry repository choices into the new
flow, validate selected targets before saving them to Linear, and retain explicit
Create & start intent only for that request. Creating without a repository remains
available; launching still requires a validated repository and installed agent.

Verification: mocked tests for both clients and native main classes, direct creation
without shaping, current/previous context, repository selection and refresh, draft
recovery, failed validation, ambiguous creation, and explicit launch. Run npm test,
npm run test:installer, npm run check and herdr-app check on both changed mods.
Inspect the native form if the running window is accessible. Do not mark CHA-4219 Done.
