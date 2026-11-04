#!/usr/bin/env python3
# Original installation tooling for Eric's Herdr Linear. MIT; see ../LICENSE.
"""Copy the personal layout into Herdr while preserving machine-local state."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time

SOURCE_ROOT = Path(__file__).resolve().parents[1]
MODS = ("linear-board", "linear-workspace", "linear-workspace-tabs",
        "erics-linear-agents", "erics-linear-chrome")
SCOPE = "layout:erics-linear"
CONFIG_NAME = "erics-linear.config.json"
RECEIPT_NAME = ".erics-linear-install.json"
MAC_KEYS = {
    "cmd-shift-c": "linear-board.crew", "cmd-shift-i": "linear-board.issue",
    "cmd-shift-a": "linear-board.agent", "cmd-shift-f": "linear-board.files",
    "cmd-shift-e": "linear-board.panel", "cmd-shift-x": "linear-board.clear",
    "cmd-alt-a": "mod.open:erics-linear-agents",
}
LINUX_KEYS = {
    "alt-shift-c": "linear-board.crew", "alt-shift-i": "linear-board.issue",
    "alt-shift-d": "linear-board.agent", "alt-shift-f": "linear-board.files",
    "alt-shift-e": "linear-board.panel", "alt-shift-x": "linear-board.clear",
    "alt-shift-a": "mod.open:erics-linear-agents",
}


def find_herdr():
    candidates = (shutil.which("herdr-app"), Path.home() / ".local/bin/herdr-app",
                  Path.home() / "Applications/Herdr.app/Contents/MacOS/herdr-app",
                  Path("/Applications/Herdr.app/Contents/MacOS/herdr-app"))
    return next((str(p) for p in candidates if p and os.access(p, os.X_OK)), None)


def checked_target(root, relative):
    """Never follow a managed child symlink into another user's files."""
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"Invalid managed path: {relative}")
    path = root
    for part in relative.parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f"Refusing to replace a symlink: {path}")
    return path


def source_plan(source, root, linux):
    relatives = [Path("layouts/erics-linear.json"), Path("layouts/erics-linear.svg")]
    for name in MODS:
        folder = source / "mods" / name
        for required in ("main.js", "mod.json"):
            if not (folder / required).is_file():
                raise ValueError(f"Missing source file: {folder / required}")
        relatives.extend(p.relative_to(source) for p in sorted(folder.rglob("*"))
                         if p.is_file() and (p.suffix in (".js", ".svg") or p.name == "mod.json"))
    plan = {}
    for relative in relatives:
        path = source / relative
        if path.is_symlink():
            raise ValueError(f"Refusing a symlink in the distribution: {path}")
        data = path.read_bytes()
        if linux and path.name == "main.js":
            data = data.replace("⌘⌥A".encode(), b"Alt+Shift+A")
        checked_target(root, relative)
        plan[str(relative)] = data
    # License notices travel with the installed derivative sources as well as Git.
    legal = [(source / "LICENSE", Path("LICENSE")),
             (source / "THIRD_PARTY_NOTICES.md", Path("THIRD_PARTY_NOTICES.md"))]
    legal.extend((p, Path("licenses") / p.name) for p in sorted((source / "licenses").glob("*")) if p.is_file())
    for path, relative in legal:
        if path.is_file():
            target = Path("licenses/erics-herdr-linear") / relative
            checked_target(root, target)
            plan[str(target)] = path.read_bytes()
    return plan


def validate_config(data):
    """Configuration accepts preference/key names, never a credential value."""
    value = json.loads(data)
    if not isinstance(value, dict) or set(value) - {"enrichment", "attention"}:
        raise ValueError("Config permits only enrichment and attention preferences")
    enrichment = value.get("enrichment", {})
    attention = value.get("attention", {})
    if not isinstance(enrichment, dict) or set(enrichment) - {"enabled", "envKey", "doppler"}:
        raise ValueError("Enrichment config permits enabled, envKey and doppler, not key values")
    if "enabled" in enrichment and not isinstance(enrichment["enabled"], bool):
        raise ValueError("enrichment.enabled must be boolean")
    env_name = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
    if "envKey" in enrichment and (not isinstance(enrichment["envKey"], str)
                                   or not env_name.fullmatch(enrichment["envKey"])):
        raise ValueError("enrichment.envKey must be an environment variable name")
    doppler = enrichment.get("doppler")
    if doppler is not None:
        if not isinstance(doppler, dict) or set(doppler) - {"project", "config", "keyNames"}:
            raise ValueError("Doppler config permits project, config and keyNames only")
        if any(not isinstance(doppler.get(key), str) or not doppler[key].strip()
               for key in ("project", "config")):
            raise ValueError("Doppler requires project and config names")
        names = doppler.get("keyNames", ["LINEAR_API_KEY"])
        if not isinstance(names, list) or not names or any(not isinstance(n, str) or not env_name.fullmatch(n) for n in names):
            raise ValueError("Doppler keyNames must be environment variable names")
    if not isinstance(attention, dict) or set(attention) - {"labels", "states"}:
        raise ValueError("Attention config permits labels and states only")
    for key, items in attention.items():
        if not isinstance(items, list) or any(not isinstance(item, str) or not item.strip() for item in items):
            raise ValueError(f"attention.{key} must be an array of nonempty strings")


def atomic_write(path, data, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    previous_mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    with tempfile.NamedTemporaryFile(prefix=f".{path.name}.", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.chmod(temporary, mode if mode is not None else previous_mode)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def git_info(source):
    try:
        commit = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True, timeout=5).strip()
        dirty = bool(subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], stderr=subprocess.DEVNULL, text=True, timeout=5).strip())
        return commit, dirty
    except (OSError, subprocess.SubprocessError):
        return None, None


def activate(binary, env):
    subprocess.run([binary, "do", "layout.switch", "--name", "erics-linear"], check=True, env=env, timeout=20)
    for _ in range(10):
        result = subprocess.run([binary, "status"], check=True, env=env, capture_output=True, text=True, timeout=10)
        status = json.loads(result.stdout)
        if status.get("layout") == "erics-linear":
            if status.get("errors"):
                raise ValueError("Layout selected but Herdr reports errors: " + "; ".join(status["errors"]))
            return
        time.sleep(0.2)
    raise ValueError("Herdr did not confirm erics-linear as the selected layout")


def install(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="Replace an earlier install, with a backup")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print the plan without writing")
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("HERDR_APP_HOME", str(Path.home() / ".config/herdr-app"))))
    parser.add_argument("--config", type=Path, help="Explicitly install non-secret machine-local preferences first")
    parser.add_argument("--select", action="store_true", help="Select the layout and verify Herdr confirms it")
    parser.add_argument("--skip-checks", action="store_true", help="Skip native shape checks, for isolated tests")
    args = parser.parse_args(argv)
    root = args.home.expanduser().resolve()
    source = SOURCE_ROOT.resolve()
    if not (root / "AGENTS.md").is_file():
        raise ValueError(f"Open Herdr once first; its configuration was not found at {root}")
    missing = [name for name in ("pane", "files", "changes", "workspace-status", "workspace-chrome")
               if not (root / "mods" / name / "main.js").is_file()]
    if missing:
        raise ValueError("Missing shipped Herdr mods: " + ", ".join(missing))
    plan = source_plan(source, root, platform.system() == "Linux")
    occupied = [name for name in MODS if (root / "mods" / name).exists()]
    if (root / "layouts/erics-linear.json").exists():
        occupied.append("layout:erics-linear")
    if occupied and not args.update:
        raise ValueError("Already installed: " + ", ".join(occupied) + ". Run again with --update to back up and replace it.")
    keys_path = checked_target(root, "keys.json")
    keys = json.loads(keys_path.read_text()) if keys_path.exists() else {}
    if not isinstance(keys, dict) or not isinstance(keys.get(SCOPE, {}), dict):
        raise ValueError("keys.json and the layout shortcut section must be objects")
    desired = LINUX_KEYS if platform.system() == "Linux" else MAC_KEYS
    old = keys.get(SCOPE, {})
    conflicts = [key for key, action in desired.items() if key in old and old[key] != action]
    if conflicts:
        raise ValueError("Layout shortcuts would replace custom bindings: " + ", ".join(conflicts))
    shadowed = [key for key in desired if key in keys.get("terminal", {})]
    if shadowed:
        raise ValueError("Terminal bindings take priority over layout shortcuts: " + ", ".join(shadowed))
    keys[SCOPE] = {**old, **desired}
    # Retire the personal OAuth popup only when its exact legacy binding exists.
    # The board uses the configured API key; unrelated global shortcuts stay intact.
    if keys.get("global", {}).get("cmd-l") == "mod.open:EricsLinear":
        keys["global"]["cmd-l"] = "mod.open:linear-board"
    keys_bytes = (json.dumps(keys, indent=2) + "\n").encode()
    config_bytes = args.config.expanduser().read_bytes() if args.config else None
    if config_bytes is not None:
        validate_config(config_bytes)
        checked_target(root, CONFIG_NAME)
    checked_target(root, RECEIPT_NAME)
    binary = find_herdr()
    if args.select and not binary:
        raise ValueError("Cannot select the layout: Herdr CLI was not found. Install/open Herdr first.")
    print(f"{'Would install' if args.dry_run else 'Installing'} Eric's Herdr Linear in {root}")
    if args.dry_run:
        print(f"{len(plan)} distribution files; {len(desired)} scoped shortcuts; machine-local state preserved")
        return 0
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = checked_target(root, Path("backups") / f"erics-herdr-linear-{stamp}")
    backup.mkdir(parents=True, exist_ok=False)

    def write(relative, data, mode=None):
        target = checked_target(root, relative)
        if target.exists():
            if target.read_bytes() == data:
                return
            saved = backup / relative
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
        atomic_write(target, data, mode)

    # Preferences precede source writes so a hot-reloaded sidebar uses the right auth.
    if config_bytes is not None:
        write(CONFIG_NAME, config_bytes, 0o600)
    for relative, data in plan.items():
        write(relative, data)
    write("keys.json", keys_bytes, 0o600)
    commit, dirty = git_info(source)
    receipt = {"source": str(source), "git_commit": commit, "git_dirty": dirty,
               "installed_at": stamp, "platform": platform.system(), "backup": str(backup),
               "files": {relative: hashlib.sha256(data).hexdigest() for relative, data in plan.items()},
               "checks": "skipped" if args.skip_checks else "not-run", "selected": False}
    receipt_path = root / RECEIPT_NAME
    write(RECEIPT_NAME, (json.dumps(receipt, indent=2) + "\n").encode(), 0o600)
    env = {**os.environ, "HERDR_APP_HOME": str(root)}
    try:
        if binary and not args.skip_checks:
            for name in MODS:
                subprocess.run([binary, "check", str(root / "mods" / name)], check=True, env=env, timeout=30)
            receipt["checks"] = "passed"
        elif not binary:
            print("Herdr CLI not found: native checks were not run. Check the mods before selecting this layout.")
        if args.select:
            activate(binary, env)
            receipt["selected"] = True
    except (ValueError, OSError, subprocess.SubprocessError):
        receipt["checks"] = "failed" if receipt["checks"] != "passed" else "passed"
        atomic_write(receipt_path, (json.dumps(receipt, indent=2) + "\n").encode(), 0o600)
        raise
    atomic_write(receipt_path, (json.dumps(receipt, indent=2) + "\n").encode(), 0o600)
    print(f"Backup: {backup}")
    print(f"Receipt: {receipt_path}")
    print("Selected erics-linear and verified its status." if receipt["selected"] else "Select erics-linear in Herdr Settings → Look when ready.")
    print("Agents shortcut: " + ("Alt+Shift+A" if platform.system() == "Linux" else "⌘⌥A"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(install())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Install did not complete: {error}", file=sys.stderr)
        sys.exit(1)
