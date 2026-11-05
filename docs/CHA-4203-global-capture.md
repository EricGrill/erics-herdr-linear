# CHA-4203: Capture an idea from outside Herdr

Discovery, 2026-11-05. Follow-up to [CHA-4200](CHA-4200-idea-capture.md), idea 4 ("Capture
from anywhere"). This is a recommendation, not approved work. No shortcut is assigned, and
no code, key binding or dependency changes are part of this document.

## Recommendation

Use an **OS-owned shortcut that runs `herdr-app do linear-board.capture`**. That command
already exists, and it opens the same capture form and recoverable draft as the in-app
entry. Herdr has no API for a system-wide hotkey, so the OS has to own the key. The key
choice stays with the person. The installer must not change OS or window-manager settings.

- **macOS (Snoke):** a Shortcuts.app shortcut with one *Run Shell Script* action, given a
  keyboard shortcut in its details. Shortcuts is built in (`/usr/bin/shortcuts` exists on
  Snoke, macOS 27.0.1), so no new dependency is needed.
- **Linux (Omarchy/Hyprland):** a `bind = …, exec, herdr-app do linear-board.capture` line
  in the person's own Hyprland config. Omarchy owns most `SUPER` combinations, so the bind
  must be checked with `hyprctl binds` on that machine first.

Text comes in by typing, by an explicit paste into the field, or by OS dictation into the
field. The wrapper never reads the clipboard by itself.

## Evidence (running app authority, `~/.config/herdr-app`)

- `herdr.d.ts` `run()` and `AGENTS.md` "Commands": keys, mods and the shell share one
  command list. `"<mod>.<command>"` goes to that mod's `nextCommand()`.
  `herdr-app do <command>` is the documented shell entry. It prints `{ "error": … }` and
  exits 1 on failure.
- `AGENTS.md` "Keys": the `keys.json` sections are `global`, `layout:<name>`, `terminal` and
  `mod:<name>`. `global` means app-wide, not system-wide: it holds `cmd-q` and `cmd-h`, which
  only work while Herdr has focus. Nothing in `herdr.d.ts` registers an OS hotkey.
- `AGENTS.md:972`: `herdr-app commands` works without an open window. This implies that
  `do` needs one. Not verified live (see gaps).
- `mods/linear-board/main.js` `onCommand`: `capture` → `dialog({ action: "capture" })`.
  Only the **sidebar** copy handles it (`if (this.role !== "sidebar") return`).
  `mods/linear-workspace/main.js:156` has the same command for the other mod.
- `gpui-kit.d.ts` lists `multiline_text_input` and an `ime_candidate` surface, and
  `AGENTS.md` notes native macOS text input. That is the path macOS Dictation uses to insert
  text. It suggests dictation works in the capture field, but this has not been verified.

## Shortcut conflicts to clear before choosing a key

Today no key is bound to `linear-board.capture`.

| Scope | Already taken (do not reuse) |
| --- | --- |
| Herdr `global` (Snoke `keys.json`) | cmd-q/h/t/w/n/p/b/d/l/,/[/]/=/+/-/0/1-9, cmd-shift-l/p/d/w/enter/[/]//, cmd-alt-h/[/]/arrows, cmd-alt-shift-arrows, ctrl-1-9, ctrl-tab, ctrl-shift-tab, f2, shift-f2 |
| `layout:erics-linear` | cmd-shift-c/i/a/f/e/x, cmd-alt-a, cmd-w (Linux: alt-shift-a/c/i/d/f/e/x) |
| `terminal` | cmd-c/v/left/right/backspace, ctrl-v, alt-left/right/backspace |
| Programs (AGENTS.md) | plain ctrl+c/d/l/r/w/a/e/u/k/z/[ ; option+letters/digits type characters on Mac layouts |
| macOS system | cmd-space (Spotlight), ctrl-space (input source), cmd-shift-3/4/5 (screenshots), cmd-tab, Globe/fn (Dictation), plus any custom ones in System Settings → Keyboard → Keyboard Shortcuts |
| Omarchy | the default `SUPER` set; list it with `hyprctl binds` |

An OS-level shortcut works while Herdr has focus too, so it would override any Herdr key
with the same combination. Candidates to check on each machine: **ctrl-option-cmd-i**
(macOS) and **SUPER-ALT-I** (Omarchy). Neither is assigned here.

## How the acceptance criteria are met

- **The person starts capture:** only the shortcut they assign starts it. Nothing runs in the
  background, and the shortcut has no clipboard or microphone access.
- **Same draft and review flow, with visible context:** the command opens the existing
  capture dialog. Team and project are shown there and can be edited (CHA-4200). The draft is
  saved as the person types.
- **Voice stays editable:** dictated text lands in the editable field. Nothing is published
  until the person clicks **Create issue**. Shaping is user-invoked. Capture never starts an
  agent or a worktree (CHA-4200 invariants).
- **Unavailable or offline:** a failed `do` exits 1. Exit 0 does not prove the form opened:
  if no sidebar copy of `linear-board` is showing, the command can do nothing and still
  succeed (gap 1). So the wrapper treats "exit 0 and the capture overlay is open" (checked
  with `herdr-app status`) as success, and anything else as failure. On failure it should
  (a) launch or raise Herdr and try once more, and (b) if that also fails, post an OS
  notification:
  "Herdr isn't open. Open it and choose Capture idea. Nothing was saved." No text was taken
  outside the app, so no idea is lost. Offline Linear is already handled: the draft is saved
  locally first.

## Gaps to verify before implementing

1. **Delivery outside the layout.** Only the `erics-linear` sidebar handles `capture`. If
   another layout is showing, the command may do nothing. Check what `do` returns in that
   case, and decide whether to switch layouts first or fall back to `mod.open`. Do not
   retry `mod.open` blindly: a second `mod.open` closes the overlay (`AGENTS.md:577`), so a
   retry could close a capture form that is already open. Check `herdr-app status` first.
2. **Window not raised.** No command brings Herdr to the front (`app.show_all` only unhides
   hidden apps on macOS). The macOS wrapper probably needs `open -a` on the Herdr app before
   `do`. On Hyprland, use `focuswindow`.
3. **Window closed.** Confirm that `do` fails clearly rather than hanging, and how long a
   fresh launch takes before `do` succeeds.
4. **Dictation in the field.** Do a live check on macOS that Dictation inserts text into
   `multiline_text_input` and that the draft saves it. On Linux, treat dictation as
   unsupported unless a system dictation tool is confirmed on the machine.
5. **Shortcuts sandbox.** *Run Shell Script* may not inherit the login PATH. Use
   `~/.local/bin/herdr-app` by absolute path, and check whether a permission prompt appears
   on first use.

## Option not recommended for the first slice

The wrapper could collect the text itself, for example with `osascript display dialog`
(a native field, so Dictation works) or a small Linux prompt. It would then pass that text
to Herdr or save it to an inbox file that the capture form imports. This works even when
Herdr is closed. However, it creates a second editor and a second storage location. The
draft also lives in Herdr's `shared.json`, so writing that file from outside the app would
race the running app. Only build this if the gaps above show that the Herdr-first path
can't be made reliable.

## Proposed follow-up (if approved)

1. Add `scripts/capture.sh`: dependency-free. It raises or launches Herdr, runs
   `herdr-app do linear-board.capture`, and sends one notification on failure. Test it with
   a stubbed `herdr-app`.
2. Add README setup steps for the macOS Shortcuts and Hyprland bind, with the conflict
   checks above. The installer only prints these steps and never applies them.
3. Do the live checks for gaps 1–5 on Snoke and omarchy2, and record the results on
   CHA-4203.
