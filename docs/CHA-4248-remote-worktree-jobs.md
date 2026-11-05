# CHA-4248: Keep remote worktree preparation alive

Snoke could validate Ventress, read its core identity and repository, and discover
its installed agents. Starting the worktree still failed with `it didn't start`.
The v0.14.2 backend spawns a detached copy of itself for background requests. In the
native remote-exec path, that worker never successfully recorded its startup marker.
Holding the parent briefly changed the outcome; assigning the worker to herdr-core
completed the same operation and remote marker launch.

Run worktree workers through `hc run` on the selected computer, with an explicit
repository cwd and independent lifetime. Preserve the backend's existing job/result
format by supplying the generated job ID to the worker. Its state directory must
exist before the backend marks startup. Validate the returned worker address against
the selected local/remote target. Allow the original 15-second startup window for
the first state-file write without launching a second worker. Keep polling on that
target, and let `--rm` plus an
owned-worker wait clean up completed jobs. A timed-out job continues in the background.

Regression tests simulate detached workers that never begin, verify remote and
explicit-local routing, and reject failed, malformed, missing and wrong-host launch
acknowledgements. Native smoke tests use a disposable Git repository with a local
bare origin and replace the agent command with a harmless marker command. They do
not create a Linear issue, change a live issue's state or launch an actual agent.

Upstream contract: [worker startup and polling](https://github.com/mrolafsson/herdr-linear/blob/v0.14.2/app.go#L627-L761),
[Darwin background implementation](https://github.com/mrolafsson/herdr-linear/blob/v0.14.2/platform_darwin.go#L112-L113).
Keep this protocol aligned with the pinned backend when upgrading it.

## Fresh repositories without an origin

The exact newly created repository also exposed a separate pinned-backend assumption:
`baseRef` defaults to `origin/main`, which does not exist in a local-only repository.
This produces Git exit 128 after the worker-lifetime problem is fixed.

When no explicit backend `base` is configured and the repository has no origin,
prepare the issue branch from local `HEAD` before calling the backend. Its existing-
branch path then creates the worktree without fabricating a remote-tracking ref.
Leave remote-backed repositories and explicit base settings on the backend's normal
path, and never reset an existing issue branch. A missing HEAD or invalid branch
fails before worker creation or the issue's start transition.
