#!/usr/bin/env python3
"""Exercise the mod's shell/JSON/background-job boundary with a supplied backend.

Uses disposable Git repositories and isolated config/state. Never contacts Linear,
reads credentials, launches an agent, or fetches from a Git remote.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def verify(binary):
    with tempfile.TemporaryDirectory(prefix="cha-4187-") as temporary:
        root = Path(temporary).resolve()
        home, config, state = (root / name for name in ("home", "config", "state"))
        for folder in (home, config, state):
            folder.mkdir()
        env = {"PATH": os.defpath, "HOME": str(home), "XDG_CONFIG_HOME": str(config),
               "XDG_STATE_HOME": str(state), "HERDR_PLUGIN_CONFIG_DIR": str(config),
               "HERDR_PLUGIN_STATE_DIR": str(state), "GIT_CONFIG_GLOBAL": os.devnull,
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "Test",
               "GIT_COMMITTER_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
               "GIT_COMMITTER_EMAIL": "test@example.invalid"}

        def git(folder, *args, check=True):
            return subprocess.run(["git", "-C", str(folder), *args], env=env,
                                  capture_output=True, check=check, timeout=15)

        def init(name):
            repo = root / name
            git(root, "init", "-q", "-b", "main", str(repo))
            git(repo, "commit", "-q", "--allow-empty", "-m", "fixture")
            return repo

        def ask(request):
            # Same positional shell arguments as client.js; no path interpolation.
            result = subprocess.run(["sh", "-c", 'exec "$0" app "$1"', str(binary),
                                     json.dumps(request)], env=env, capture_output=True,
                                    check=True, timeout=15)
            reply = json.loads(result.stdout)
            if reply.get("error"):
                raise AssertionError(reply["error"])
            return reply

        def worktree(repo, branch):
            reply = ask({"op": "worktree", "repo": str(repo), "bg": True,
                         "target": {"branch": branch, "teamKey": "CHA",
                                    "workspaceKey": "fixture", "identifier": "CHA-4187"}})
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                status = ask({"op": "job", "job": reply["job"]})
                if status.get("done"):
                    result = status["result"]
                    if result.get("error"):
                        raise AssertionError(result["error"])
                    return result
                time.sleep(0.02)
            raise AssertionError("Background worktree job timed out")

        sibling = init("notes")
        (config / "config.json").write_text(json.dumps({
            "base": "main", "repos": {"CHA": str(sibling), "fixture/CHA": str(sibling),
                                        "": str(sibling)}}))
        for number, name in enumerate(("notes ", "notes\n", "line\nbreak", "notes\t", "notes\r")):
            repo, branch = init(name), f"fixture/cha-4187-{number}"
            want = home / ".herdr" / "worktrees" / name / branch.replace("/", "-")
            first = worktree(repo, branch)
            assert first["path"] == str(want) and first["created"] is True, first
            common = git(want, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout
            assert common.removesuffix(b"\n") == os.fsencode(repo / ".git"), common
            assert git(sibling, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}",
                       check=False).returncode != 0, "Branch created in trimmed sibling"
            second = worktree(repo, branch)
            assert second["path"] == str(want) and second["created"] is False, second
            print(f"PASS shell/JSON/background create and reopen: {name!r}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, help="Absolute or relative path to a compiled herdr-linear")
    verify(parser.parse_args().binary.resolve(strict=True))
