# CHA-4187: exact repository paths

These are reviewable, tested patches, **not an installed or released fix**. The active
clients still pin upstream v0.14.2 and retain the path/routing guards. Do not apply the
client patch to a distributed build until its backend pin is changed to a published,
compatible release. v0.14.2 silently ignores the new `repo` field.

## Backend patch

`backend.patch` applies to `mrolafsson/herdr-linear` v0.14.2, commit
`0b031488214e37c0ee06ec7b08455173d64dac52`. It adds an optional `repo` string to the
`app` worktree JSON request. A nonempty value must be an absolute, existing Git
checkout root; it takes precedence over both scoped/unscoped team mappings and
`dirs`. An invalid override fails before worktree creation and never falls back.
An omitted or empty value retains the existing config-then-dirs resolution order.
Linked worktrees with a `.git` file are valid bases.

Path operations read raw Git stdout and remove only Git's single terminating LF.
This is necessary in both `app.go` and the shared Git helper: removing only the
visible `TrimSpace` in `app.go` is insufficient. Existing non-path Git callers keep
their trimming behavior. Worktree lookup uses `--porcelain -z`, and worktree removal
also preserves the common-directory path. Main-checkout exclusion, existing branch
handling, base selection and worktree placement remain intact.

Apply and verify in a disposable upstream checkout:

```sh
git checkout --detach 0b031488214e37c0ee06ec7b08455173d64dac52
git apply /absolute/path/to/patches/cha-4187/backend.patch
go test ./...
go vet ./...
go build -o /tmp/cha-4187-herdr-linear .
python3 /absolute/path/to/patches/cha-4187/verify_backend.py /tmp/cha-4187-herdr-linear
```

The upstream Go module declares its own toolchain and existing dependencies; this
change adds none. Tests use disposable repositories, `base: main`, and isolated
Git config. The Python smoke test supplies an isolated HOME, config and state,
passes the request through the same positional shell/JSON boundary as the client,
and exercises actual background jobs. It does not contact Linear, fetch remotes,
read credentials, create tickets or launch agents.

## Client adoption patch

`client-adoption.patch` applies to this repository at `f12d082`. It is deliberately
unapplied and does **not** invent a release version. Adoption must be one atomic
change with a compatible backend pin and its real release checksums/download URL.
If a fork is chosen, also update provisioning's source/cache identity and the
third-party notice; a fork must not reuse the upstream v0.14.2 binary cache.

The patch sends `repo: execution.folder` from both clients and preserves the original
Linear team/workspace identity. It removes the empty-team routing workaround, the
obsolete configuration guard and its tests, and the whitespace/newline restriction.
New tests cover exact discovery/validation beside a trimmed sibling, the serialized
worktree request on the selected computer, and unchanged creation team/project and
start team identity. Existing `.git` file/worktree tests stay in place.

After selecting a compatible published release, apply the client patch, change both
`LINEAR_VERSION` pins together, update release provenance notices, and verify:

```sh
npm test
npm run test:installer
npm run check
herdr-app check mods/linear-board
herdr-app check mods/linear-workspace
```

Then validate the published binary with `verify_backend.py` before installing it.
The prepared patch was checked in a disposable worktree; it has not been installed
in a live Herdr layout, and no live agent launch or Linear ticket mutation was used
as a test.

## Verification recorded on 2026-11-03

- Backend regression tests failed against unmodified v0.14.2, including the
  trailing-space/sibling collision, and passed with `backend.patch`.
- Full upstream `go test ./...` and `go vet ./...` passed using Go 1.27.3 on macOS arm64.
- Compiled-binary smoke test passed create/reopen cases for trailing space, tab,
  CR, trailing LF and embedded LF, despite conflicting configured team repos.
- Prepared client patch: 395 tests, 15 installer tests, structure/import/SVG check,
  and both native mod checks passed.
- Active, unchanged clients: 397 tests, 15 installer tests and structure check passed.

The remaining dependency is a published compatible release and the release-source
choice (upstream contribution versus maintained fork). No version, deployment,
upstream submission or issue completion is claimed by these artifacts. Keep progress
on CHA-4187; do not mark it Done when an agent run ends.
