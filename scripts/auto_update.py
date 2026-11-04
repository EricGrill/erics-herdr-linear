#!/usr/bin/env python3
# Original update tooling for Eric's Herdr Linear. MIT; see ../LICENSE.
"""Keep this machine on the commit CI verified, without anyone logging in.

CI moves the `verified` branch to a `main` commit only after its checks pass. A timer
(launchd on macOS, a systemd user timer on Linux) runs `auto_update.py run` every few
minutes. When `origin/verified` moves, it runs `scripts/update.sh --to <commit>`, which
fast-forwards this checkout and runs `install.py --update`. A machine that was asleep
or offline catches up on its next run.

Nothing is overwritten: a checkout with local changes, on another branch, or with
commits that are not on `verified` is skipped. Each outcome is reported as a GitHub
commit status (`deploy/<machine>`, via `gh` when it is signed in) and a desktop
notification, once per commit and reason. Credentials are never read here.

  python3 scripts/auto_update.py install [--machine NAME] [--interval SECONDS] [--dry-run]
  python3 scripts/auto_update.py run [--now]
  python3 scripts/auto_update.py status
  python3 scripts/auto_update.py uninstall
"""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
# Not "deploy": the repo has deploy/* branches, and git cannot hold both names.
DEPLOY_BRANCH = "verified"
MAIN_BRANCH = "main"
LABEL = "com.ericgrill.erics-herdr-linear.auto-update"
UNIT = "erics-herdr-linear-update"
RECEIPT_NAME = ".erics-linear-install.json"
OFFLINE_ALERT_HOURS = 24
# A failed install of the same commit is retried after these waits; the last one repeats.
# Each try makes a backup and may switch layouts, so a failure that persists must not
# rerun every timer tick. `run --now` retries at once.
RETRY_DELAYS = [datetime.timedelta(minutes=15), datetime.timedelta(hours=1),
                datetime.timedelta(hours=4), datetime.timedelta(hours=24)]
# Timers start with a bare PATH. Include where Homebrew, ~/.local and mise (omarchy2's gh)
# put tools, so gh, herdr-app and python3 resolve the same way as in a login shell.
PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".local/bin"),
             str(Path.home() / ".local/share/mise/shims"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")
    return Path(base) / "erics-herdr-linear"


def herdr_home():
    return Path(os.environ.get("HERDR_APP_HOME", str(Path.home() / ".config/herdr-app"))).expanduser()


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def log(message):
    print(f"{now().strftime('%Y-%m-%dT%H:%M:%SZ')} {message}", flush=True)


def git(*args, timeout=30, check=True):
    result = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {(result.stderr or result.stdout).strip()}")
    return result.stdout.strip()


def is_ancestor(older, newer):
    return subprocess.run(["git", "-C", str(REPO), "merge-base", "--is-ancestor", older, newer],
                          capture_output=True, timeout=30).returncode == 0


def machine_name():
    configured = load_json(state_dir() / "config.json", {}).get("machine")
    return configured or socket.gethostname().split(".")[0].lower()


def sidebar_version(layout_path):
    def walk(node):
        yield node
        for child in node.get("children", []):
            yield from walk(child)
    try:
        layout = json.loads(Path(layout_path).read_text())
        footer = next(node for node in walk(layout) if node.get("id") == "sidebar-footer")
        return footer["content"]["props"]["version"]
    except (OSError, ValueError, KeyError, TypeError, StopIteration):
        return None


def installed():
    """What this machine runs now: the receipt commit and the installed sidebar version."""
    home = herdr_home()
    receipt = load_json(home / RECEIPT_NAME, {})
    return {"commit": receipt.get("git_commit"), "installed_at": receipt.get("installed_at"),
            "selected": receipt.get("selected"), "checks": receipt.get("checks"),
            "version": sidebar_version(home / "layouts/erics-linear.json")}


def github_repo():
    url = git("remote", "get-url", "origin", check=False)
    match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", url)
    return match.group(1) if match else None


def report_status(commit, state, description):
    """Mark the commit on GitHub. Uses the machine's existing gh sign-in; skipped without it."""
    slug, gh = github_repo(), shutil.which("gh")
    if not slug or not gh:
        log("GitHub status not reported: gh or a GitHub origin is unavailable")
        return False
    result = subprocess.run(
        [gh, "api", "--method", "POST", f"repos/{slug}/statuses/{commit}",
         "-f", f"state={state}", "-f", f"context=deploy/{machine_name()}",
         "-f", f"description={description[:139]}"],
        capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        log(f"GitHub status not reported: {(result.stderr or result.stdout).strip()[:300]}")
    return result.returncode == 0


def notify(title, message):
    try:
        if platform.system() == "Darwin":
            script = f"display notification {json.dumps(message)} with title {json.dumps(title)}"
            subprocess.run(["osascript", "-e", script], capture_output=True, timeout=15)
        elif shutil.which("notify-send"):
            subprocess.run(["notify-send", "--app-name=Herdr", title, message], capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        pass


def herdr_running():
    """install.py --select needs the window open; without it, install and leave selection alone."""
    binary = shutil.which("herdr-app") or str(Path.home() / ".local/bin/herdr-app")
    if not os.access(binary, os.X_OK):
        return False
    try:
        result = subprocess.run([binary, "status"], capture_output=True, text=True, timeout=10)
        return result.returncode == 0 and isinstance(json.loads(result.stdout), dict)
    except (OSError, subprocess.SubprocessError, ValueError):
        return False


def short(commit):
    return (commit or "none")[:7]


class Skip(Exception):
    """The checkout cannot be updated safely; nothing was changed."""


def preflight(target):
    branch = git("branch", "--show-current")
    if branch != MAIN_BRANCH:
        raise Skip(f"checkout is on {branch or 'a detached HEAD'}, not {MAIN_BRANCH}")
    if git("status", "--porcelain"):
        raise Skip("checkout has local changes")
    if not is_ancestor(target, f"origin/{MAIN_BRANCH}"):
        raise Skip(f"{DEPLOY_BRANCH} {short(target)} is not on origin/{MAIN_BRANCH}")
    if not is_ancestor("HEAD", target):
        raise Skip(f"checkout has commits that are not on {DEPLOY_BRANCH}")


def finish(state, target, outcome, message, notify_title):
    """Record and report one outcome; repeat reports only when the commit or reason changes.

    The GitHub status is marked reported only once `gh` accepts it, so a failed report is retried
    on the next run instead of leaving deploy/<machine> pending. The desktop alert is sent once.
    """
    key = f"{target}:{outcome}:{message}"
    if state.get("notified") != key:
        if notify_title:
            notify(notify_title, message)
        state["notified"] = key
    if state.get("reported") != key:
        github_state = {"success": "success", "skipped": "failure", "failed": "error"}[outcome]
        if report_status(target, github_state, message):
            state["reported"] = key
    state.update(last_target=target, last_outcome=outcome, last_message=message,
                 last_run=now().isoformat())
    log(f"{outcome}: {message}")


def run(retry_now=False):
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / "lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log("another update is running")
            return 0
        state_path = directory / "state.json"
        state = load_json(state_path, {})
        try:
            return run_locked(state, retry_now)
        finally:
            save_json(state_path, state)


def run_locked(state, retry_now=False):
    machine = machine_name()
    def fetch(branch):
        return subprocess.run(["git", "-C", str(REPO), "fetch", "--quiet", "origin",
                               f"+refs/heads/{branch}:refs/remotes/origin/{branch}"],
                              capture_output=True, text=True, timeout=120)
    fetched = fetch(MAIN_BRANCH)
    if fetched.returncode != 0:
        # Offline (asleep, no network): try again next run. Say so if it lasts, counting from
        # the last good fetch, or from the first failed one if GitHub was never reached.
        last_ok = state.get("last_fetch_ok") or state.setdefault("offline_since", now().isoformat())
        log(f"fetch failed: {fetched.stderr.strip()[:300]}")
        if not state.get("offline_alerted"):
            hours = (now() - datetime.datetime.fromisoformat(last_ok)).total_seconds() / 3600
            if hours >= OFFLINE_ALERT_HOURS:
                notify("Herdr Linear is not updating",
                       f"{machine} could not reach GitHub for {int(hours)} hours; it is not getting new releases.")
                state["offline_alerted"] = True
        return 1
    state["last_fetch_ok"] = now().isoformat()
    state.pop("offline_alerted", None)
    state.pop("offline_since", None)
    deploy_fetch = fetch(DEPLOY_BRANCH)
    if deploy_fetch.returncode != 0:
        log(f"fetch {DEPLOY_BRANCH}: {deploy_fetch.stderr.strip()[:300]}")

    target = git("rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{DEPLOY_BRANCH}", check=False)
    if not target:
        log(f"origin has no {DEPLOY_BRANCH} branch yet; nothing to install")
        return 0
    current = installed()
    # install.py records the commit before its mod checks and --select run, so a matching
    # receipt alone does not mean the install worked. A failed one is retried every run.
    failed_before = state.get("failed_target") == target
    install_failed = failed_before or current["checks"] == "failed"
    if git("rev-parse", "HEAD") == target and current["commit"] == target and not install_failed:
        finish(state, target, "success", describe(current), None)
        return 0
    retry_after = state.get("retry_after") if failed_before else None
    if retry_after and not retry_now and now() < datetime.datetime.fromisoformat(retry_after):
        # Keep the failure visible (a status gh rejected is retried) but do not reinstall yet.
        finish(state, target, "failed", state.get("failed_message") or f"Install of {short(target)} failed",
               "Herdr Linear update failed")
        log(f"next try of {short(target)} after {retry_after} (attempt {state.get('failed_attempts', 1) + 1};"
            " `auto_update.py run --now` retries at once)")
        return 1
    head = git("rev-parse", "HEAD")
    if head != target and is_ancestor(target, head) and is_ancestor(head, f"origin/{MAIN_BRANCH}"):
        # Someone pulled main by hand before CI finished; deploy will catch up to it.
        log(f"checkout {short(head)} is ahead of {DEPLOY_BRANCH} {short(target)}; waiting for CI")
        return 0

    try:
        preflight(target)
    except Skip as reason:
        finish(state, target, "skipped", f"Skipped on {machine}: {reason}; nothing was changed",
               "Herdr Linear update skipped")
        return 1

    # After a failed try that selected the layout, retries of that commit leave selection alone,
    # so a layout Herdr reports errors for is not switched back on again and again.
    select_failed = failed_before and state.get("failed_with_select")
    select = not select_failed and herdr_running()
    command = ["bash", str(REPO / "scripts/update.sh"), "--to", target] + (["--select"] if select else [])
    why = ("and selecting the layout" if select else
           "(not selecting: it failed with selection before)" if select_failed else
           "(Herdr not running; not selecting)")
    log(f"installing {short(target)} {why}")
    env = {**os.environ, "PATH": os.pathsep.join(PATH_DIRS + [os.environ.get("PATH", "")])}
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=900, env=env)
        output, code = (result.stdout + result.stderr).strip(), result.returncode
    except subprocess.TimeoutExpired:
        output, code = "update.sh timed out", 1
    print(output, flush=True)
    current = installed()
    if code != 0 or current["commit"] != target or current["checks"] == "failed":
        attempts = state.get("failed_attempts", 0) + 1 if failed_before else 1
        delay = RETRY_DELAYS[min(attempts, len(RETRY_DELAYS)) - 1]
        last_line = output.splitlines()[-1] if output else f"exit {code}"
        message = f"Install of {short(target)} failed on {machine}: {last_line}"
        state.update(failed_target=target, failed_attempts=attempts, failed_message=message,
                     failed_with_select=bool(select or select_failed),
                     retry_after=(now() + delay).isoformat())
        finish(state, target, "failed", message, "Herdr Linear update failed")
        return 1
    for key in ("failed_target", "failed_attempts", "failed_message", "failed_with_select", "retry_after"):
        state.pop(key, None)
    finish(state, target, "success", describe(current), "Herdr Linear updated")
    return 0


def describe(current):
    # Without --select (Herdr was closed) install.py leaves the chosen layout alone, so a
    # receipt with selected=false says nothing about whether erics-linear is selected.
    selected = "selected" if current["selected"] else "selection unchanged"
    return (f"{machine_name()} runs v{current['version'] or '?'} at {short(current['commit'])}"
            f" ({selected}, checks {current['checks'] or '?'})")


def status():
    current = installed()
    state = load_json(state_dir() / "state.json", {})
    deploy = git("rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{DEPLOY_BRANCH}", check=False)
    print(json.dumps({"machine": machine_name(), "checkout": git("rev-parse", "HEAD"),
                      "branch": git("branch", "--show-current"), "deploy": deploy or None,
                      "installed_commit": current["commit"], "installed_at": current["installed_at"],
                      "sidebar_version": current["version"], "selected": current["selected"],
                      "last_outcome": state.get("last_outcome"), "last_message": state.get("last_message"),
                      "last_run": state.get("last_run"), "last_fetch_ok": state.get("last_fetch_ok"),
                      "retry_after": state.get("retry_after"), "failed_attempts": state.get("failed_attempts"),
                      "log": str(state_dir() / "auto-update.log")}, indent=2))
    return 0


def service_files(interval):
    # Resolve python3 through PATH at run time, so a Homebrew Python upgrade does not break it.
    python = "/usr/bin/env python3"
    script = str(REPO / "scripts/auto_update.py")
    logfile = str(state_dir() / "auto-update.log")
    path = os.pathsep.join(PATH_DIRS)
    if platform.system() == "Darwin":
        plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/env</string><string>python3</string><string>{script}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>{path}</string></dict>
  <key>WorkingDirectory</key><string>{REPO}</string>
  <key>StartInterval</key><integer>{interval}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{logfile}</string>
  <key>StandardErrorPath</key><string>{logfile}</string>
</dict>
</plist>
"""
        return {Path.home() / f"Library/LaunchAgents/{LABEL}.plist": plist}
    units = Path(os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")) / "systemd/user"
    service = f"""[Unit]
Description=Install new verified releases of Eric's Herdr Linear
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory={REPO}
Environment=PATH={path}
ExecStart={python} {script} run
StandardOutput=append:{logfile}
StandardError=append:{logfile}
"""
    timer = f"""[Unit]
Description=Check for new verified releases of Eric's Herdr Linear

[Timer]
OnBootSec=2min
OnUnitActiveSec={interval}s
Persistent=true

[Install]
WantedBy=timers.target
"""
    return {units / f"{UNIT}.service": service, units / f"{UNIT}.timer": timer}


def install_service(args):
    files = service_files(args.interval)
    if args.dry_run:
        for path, text in files.items():
            print(f"# {path}\n{text}")
        return 0
    if args.machine and not re.fullmatch(r"[A-Za-z0-9_.-]+", args.machine):
        raise ValueError("Machine name may use letters, digits, '.', '_' and '-'")
    config_path = state_dir() / "config.json"
    save_json(config_path, {**load_json(config_path, {}), "machine": args.machine or machine_name()})
    for path, text in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    if platform.system() == "Darwin":
        domain = f"gui/{os.getuid()}"
        (plist,) = files
        subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], capture_output=True)
        subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    else:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", f"{UNIT}.timer"], check=True)
    print(f"Automatic updates on for {machine_name()}, every {args.interval}s. Log: {state_dir() / 'auto-update.log'}")
    return 0


def uninstall_service():
    files = service_files(300)
    if platform.system() == "Darwin":
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    else:
        subprocess.run(["systemctl", "--user", "disable", "--now", f"{UNIT}.timer"], capture_output=True)
    for path in files:
        path.unlink(missing_ok=True)
    if platform.system() != "Darwin":
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    print("Automatic updates off. The checkout and the installed layout are unchanged.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser("run", help="Install the deploy commit if this machine is behind")
    run_parser.add_argument("--now", action="store_true", help="Retry a failed install without waiting")
    commands.add_parser("status", help="Show the deploy commit, installed commit and sidebar version")
    setup = commands.add_parser("install", help="Run automatically (launchd or systemd user timer)")
    setup.add_argument("--machine", help="Name used in the GitHub status (default: short host name)")
    setup.add_argument("--interval", type=int, default=300, help="Seconds between checks (default 300)")
    setup.add_argument("--dry-run", action="store_true", help="Print the service files without writing")
    commands.add_parser("uninstall", help="Stop running automatically")
    args = parser.parse_args(argv)
    if args.command == "run":
        return run(args.now)
    if args.command == "status":
        return status()
    if args.command == "install":
        return install_service(args)
    return uninstall_service()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"auto_update: {error}", file=sys.stderr)
        sys.exit(1)
