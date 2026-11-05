# CHA-4202: Screenshot evidence for idea capture

Discovery proposal, 2026-11-05. This is the follow-up to CHA-4200, idea 3 ("Screenshot plus one sentence"). It covers design only. Implementation should be a separate ticket once this is approved.

## Problem

CHA-4200 itself shows the gap. Its description contains a local CleanShot path (`/Users/eric/Library/Application Support/CleanShot/media/…png`). Nobody else can open that path: not Linear, not an agent on another machine, not a reviewer. A local path looks like evidence, but it isn't. The capture form needs a way to attach a screenshot on purpose and get back a Linear-hosted copy that the ticket actually references.

## Recommendation

1. The user explicitly adds a screenshot in the capture form, either by **pasting** with ⌘V when the clipboard holds an image or by **dropping** an image file on the form. The app never reads the clipboard by itself and never scans screenshot folders.
2. The form shows a **preview** with a **Remove** button. The image is copied into the mod's own data folder so that `image()` can render it and the draft can recover it.
3. On **Create ticket**, each screenshot is uploaded to Linear first. Then the issue is created with the returned asset URL embedded in an **Evidence** section of the description. The user's original idea text is kept as-is under Source idea.
4. A screenshot shows as attached only after the upload is confirmed **and** the created issue's description has been read back and contains its asset URL. Until then it is in a pending or failed state, and the draft stays saved.

## Verified platform facts (Herdr 0.1.12 on snoke)

| Need | What exists | Usable here? |
|---|---|---|
| Clipboard image | `feedbackPasteImage()` (`herdr.d.ts:315`) | **No.** Frame-only, so it is limited to the app's own feedback screen. |
| Image picker | `feedbackPickImages()` (`herdr.d.ts:317`), `pickFolder()` (`:37`) | **No.** The feedback picker is frame-only. `pickFolder` picks folders, not files. Mods have no file picker. |
| Drop files | `.on_drop(({paths}) => …)` on a plain layout element (`gpui-kit.d.ts:783`) | **Yes.** Gives absolute paths of files dropped from outside the app. A CleanShot thumbnail can be dragged onto the form. |
| Detect an image paste | `on("paste_other")` on `InputState`/`TextareaState`: "a paste found no text (an image, say)" (`gpui-kit.d.ts:21341`, `:21410`) | **Yes, as a trigger only.** It returns no image data. |
| Read clipboard image data | `read_from_clipboard()` is text only (`gpui-kit.d.ts:346`) | **Only through `exec`.** On macOS, `osascript` writes `the clipboard as «class PNGf»` to a file. It is present on snoke. `pngpaste` is not installed and must not be added. On Linux, use `wl-paste --type image/png` or `xclip -selection clipboard -t image/png -o` if one is installed (neither is on snoke). Otherwise report "Pasting images isn't supported on this computer; drop the file instead." Windows is out of scope for v1. |
| Read/write image bytes | `fs/promises` `readFile(path) → Uint8Array`, `writeFile(path, Uint8Array)`: read anywhere in home, write only under `~/.config/herdr-app` (`gpui-kit.d.ts:22126`, AGENTS.md "Other built-ins") | **Yes.** |
| Preview | `image(path)`, resolved against `~/.config/herdr-app` (`gpui-kit.d.ts:20290`) | **Yes, after copying** the image to `~/.config/herdr-app/data/linear-workspace/evidence/<draftId>/<uuid>.<ext>`. That location is a deployment folder, never the Git repo. |
| Upload transport | `fetch` accepts a `Uint8Array` body (`gpui-kit.d.ts:22185`). The existing credential shell (`auth.js`) runs `curl` | **Yes.** |
| `exec` limits | 30 s and 8 MiB of output per call (`herdr.d.ts:10`) | An `osascript choose file` picker would block on the user and hit the 30 s limit, so it is **rejected**. Upload PUTs need a timeout under 30 s. |

The clipboard step through `osascript` has not been run on snoke. Reading or replacing Eric's real clipboard is not acceptable as a test, so the implementation ticket needs one manual check with a sample image the user copies.

### Linear upload support

From [How to upload a file to Linear](https://linear.app/developers/how-to-upload-a-file-to-linear), reviewed 2026-11-05:

- `fileUpload(contentType, filename, size)` returns `success` and `uploadFile { uploadUrl assetUrl headers { key value } }`.
- The client sends `PUT uploadUrl` with the file as the body. It must copy every returned header, set `Content-Type` to the file's MIME type, and set `Cache-Control: public, max-age=31536000`. A 403 response usually means headers were missing.
- The `assetUrl` points to Linear's private storage. It works inside Linear, and reading it from anywhere else needs the API key.
- To attach the file, reference `assetUrl` in markdown (`![alt](assetUrl)`) in the issue description or in a comment. `attachmentCreate` is for link cards, not image evidence, so v1 doesn't use it.

The current `api.js` has no upload operation, and the pinned herdr-linear Go backend isn't needed for this. The mod's own API-key path (`auth.js` → `queryLinear`) can run `fileUpload`, so **no backend or fork decision is required**.

## Design

### Evidence entry in the draft

The draft schema (`capture.js`, now v1 → v2 with migration) gets `evidence: Entry[]`, with at most 3 entries to match Herdr's feedback limit:

```
{ id, state: "selected" | "uploading" | "uploaded" | "attached" | "failed",
  file: "<uuid>.png",            // relative to the draft's evidence folder; never the source path
  name: "Screenshot 1.png",      // display name; the source filename is not kept
  mime, size, sha256,
  assetUrl?: string,             // set once the PUT is confirmed
  error?: string }               // short, user-facing; no bytes, headers or URLs
```

The draft stores only the reference. Image bytes never go into `shared()`/`localStorage`. The original source path is never stored, logged or sent.

### State machine

```
selected ──Create──▶ uploading ──PUT 2xx──▶ uploaded ──issue read back contains assetUrl──▶ attached
    ▲                     │                    │
    └──Retry── failed ◀───┘   (fileUpload error, PUT non-2xx, timeout, size/type mismatch)
                                               └──create failed──▶ stays "uploaded" (assetUrl reused on retry, no re-upload)
Remove (any state except uploading) ──▶ entry and local copy deleted
```

- **selected**: the image is copied locally and passed validation (magic bytes for PNG/JPEG/GIF/WebP, ≤ 10 MiB; the extension isn't trusted). It shows a preview, a Remove button and the label "Not uploaded yet".
- **uploading**: Create and Remove are disabled for that entry. A repeated click doesn't start a second upload.
- **uploaded**: Linear accepted the bytes. It's labelled "Uploaded, not yet on a ticket". It is never shown as attached.
- **attached**: the only success state. The issue was read back (`query issue { description }`) and the description contains this entry's `assetUrl`.
- **failed**: it stays in the list in an error color, with **Retry** and **Remove**. Create is blocked while any entry is failed or selected-but-unsent, unless the user explicitly chooses **Create without screenshots**. Then those entries stay in the draft as unresolved, so they can't silently vanish.

### Create sequence

1. Save the draft (it already exists) with evidence in `selected`.
2. For each unsent entry: `fileUpload` through `queryLinear`, then a PUT of the local copy. Use `curl --upload-file` in the same `exec` shell pattern, with the signed headers written to a mode-0600 temp curlrc and deleted on exit. Then move the entry to `uploaded` and save.
3. `issueCreate` with the description = the edited description + `\n\n## Evidence\n\n![Screenshot 1](assetUrl)…`, with the source idea kept verbatim as today.
4. Read the created issue back. Each entry whose `assetUrl` appears moves to `attached`. Any entry that is missing stays `uploaded`, and the user gets "Ticket created; screenshot not confirmed on it" with a **Retry attaching** action. That action uses `commentCreate` with the image markdown and confirms it by reading the comment body back.
5. Discard the draft and delete its evidence folder **only when** every entry is `attached` or was removed. `completeCapture` currently discards on create (`mods/linear-workspace/client.js:1315`, and the same code in the board client). That call needs this guard.

Partial failures keep the draft in a state the user can recover from:
- **Upload fails**: no ticket is created, and the draft and images stay.
- **Create fails after upload**: the entries stay `uploaded` with `assetUrl`, and Retry reuses the asset. An orphaned asset in Linear's private storage is acceptable. Linear has no documented delete for it.
- **Create is ambiguous**: use the existing "Creation not confirmed" reconciliation, matching on the `assetUrl` in recent issue descriptions.

### Privacy and logging

- Never `console.log` image bytes, base64, signed upload URLs/headers, asset URLs, or source paths. Errors shown to the user are generic: "Upload failed (HTTP 403)".
- The local copy lives under `~/.config/herdr-app/data/…`. It is deleted on Remove, on discard, and when a draft is fully attached. It is never inside the repo. Add a check-script guard so that no `*.png` appears under `mods/*/evidence/`.
- Explicit only. Nothing runs at open, on a timer, or in the background. `paste_other` fires only on the user's own ⌘V into a capture field. A pasted text path is not uploaded, but the form may offer an **Attach this file** button for an absolute image path in the text. That button reads only that one file, and only when clicked.

### Both client copies

Capture lives in both `mods/linear-workspace` and `mods/linear-board`. Put the new pure logic (state transitions, validation, description building, verification) in a new `evidence.js`, kept byte-identical in both mods with an identity test. The two `capture.js` copies already differ slightly, so extend each one for the v2 schema. Keep `client.js` wiring thin. Adding an import means updating the test harness stubs and the client.test allowlist in every harness.

## Implementation acceptance checks (all with mocks)

Use generated sample images only: a 1×1 PNG and JPEG built from bytes in the test, plus a truncated or renamed non-image. Mock `exec`, `fetch`, `queryLinear` and `fs`. Use no real tickets, credentials, clipboard or agents.

1. Paste (mocked `osascript` output file) and drop both produce a `selected` entry with a preview path under the evidence folder. Unsupported types, oversized files and a 4th image are rejected with a message.
2. Remove deletes the entry and its local copy. The draft survives close/reopen with evidence intact, and is isolated per workspace.
3. A successful flow goes selected → uploading → uploaded → attached only after the mocked issue read-back contains the `assetUrl`. A read-back without it leaves the entry `uploaded` and does not report success.
4. A `fileUpload` error, PUT 403 or timeout → `failed`. Create is blocked. Retry works. The draft is kept.
5. If `issueCreate` fails after upload, the next attempt reuses the `assetUrl` (exactly one `fileUpload` per image) and the draft is kept.
6. Double-clicking Create makes exactly one upload per image and one `issueCreate`.
7. The original idea text appears verbatim in the created description alongside the Evidence section.
8. Log and draft snapshots contain no image bytes, base64, signed headers or source paths, and `git status` stays clean after a test run.
9. Both client copies pass the same behavior tests, plus `npm test`, `npm run test:installer`, `npm run check`, and `herdr-app check` on both mods. Do one manual native check: copy a sample PNG, press ⌘V in the capture field, preview, Remove, then re-add and create against a throwaway Linear team only with Eric's approval. Without approval, use the mocked flow.

## Open decisions for Eric

1. **Clipboard route.** Recommended: `osascript` through `exec` now (macOS), with drop as the cross-platform path. Alternative: ask Herdr upstream to let mods use the `feedback*` image helpers, which already handle conversion and limits. That is cleaner but outside this repo's control.
2. **Create without screenshots.** Recommended: allow it as an explicit secondary action, leaving unresolved entries in the draft. Alternative: block Create until every image is attached or removed.
3. **Where evidence goes.** Recommended: an Evidence section in the issue description at create time, so one mutation carries it. Alternative: always post a comment after create. That is simpler to retry, but the screenshot is less visible.

## Risks

- **Clipboard formats.** CleanShot and macOS normally put PNG/TIFF on the clipboard. Coercing to `«class PNGf»` should cover both, but that hasn't been tested live.
- **Upload and auth.** The upload URL and headers come from Linear and may change shape. Validate the response and fail closed. `Cache-Control` must be present or the PUT may 403.
- **Retention.** Uploaded-but-unreferenced assets can't be deleted through the documented API. Local copies need cleanup on discard, and a startup sweep should remove evidence folders whose draft no longer exists. That sweep is scoped to the mod's own folder only.
- **Remote machines.** If capture targets another computer, the image is still local. Keep uploads on the local machine, which is where the API key is resolved today (`new LinearAPI(config)` with no `on`, `client.js:365`).
