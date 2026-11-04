#!/usr/bin/env python3
# Original release tooling for Eric's Herdr Linear. MIT; see ../LICENSE.
"""Raise the patch version in package.json and the sidebar footer together.

CI runs this for every verified merge to main, so each deploy shows a new version
(0.1.1 -> 0.1.2 -> ...). Only the two version strings change; formatting is kept.

  python3 scripts/bump_version.py                 # bump, print the new version
  python3 scripts/bump_version.py --since REV      # no bump if the version changed since REV

With --since, a merge that set the version by hand (for example a minor release) is
released as it is. Prints the version to release either way.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
PACKAGE = "package.json"
LAYOUT = "layouts/erics-linear.json"
VERSION = re.compile(r'("version"\s*:\s*")([^"]*)(")')


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def footer_version(layout):
    footer = next(node for node in walk(layout) if node.get("id") == "sidebar-footer")
    return footer["content"]["props"]["version"]


def next_patch(version):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    if not match:
        raise ValueError(f"Cannot bump version {version!r}: expected MAJOR.MINOR.PATCH")
    major, minor, patch = (int(part) for part in match.groups())
    return f"{major}.{minor}.{patch + 1}"


def replace_after(text, marker, old, new):
    """Replace the first "version": "old" after marker, leaving the rest of the text alone."""
    start = text.index(marker) if marker else 0
    match = VERSION.search(text, start)
    if not match or match.group(2) != old:
        raise ValueError(f"Could not find version {old!r} after {marker or 'the start'}")
    return text[:match.start(2)] + new + text[match.end(2):]


def version_at(root, rev):
    shown = subprocess.run(["git", "-C", str(root), "show", f"{rev}:{PACKAGE}"],
                           capture_output=True, text=True)
    if shown.returncode != 0:
        return None
    return json.loads(shown.stdout).get("version")


def bump(root=REPO, since=None):
    package_path, layout_path = root / PACKAGE, root / LAYOUT
    package_text, layout_text = package_path.read_text(), layout_path.read_text()
    current = json.loads(package_text)["version"]
    layout = json.loads(layout_text)
    if footer_version(layout) != current:
        raise ValueError(f"Sidebar footer {footer_version(layout)!r} does not match package.json {current!r}")
    if since and version_at(root, since) not in (None, current):
        return current
    new = next_patch(current)
    new_package = replace_after(package_text, None, current, new)
    new_layout = replace_after(layout_text, '"sidebar-footer"', current, new)
    # The edit must change nothing but the two versions.
    expected = json.loads(package_text) | {"version": new}
    if json.loads(new_package) != expected:
        raise ValueError("package.json changed beyond its version")
    footer = next(node for node in walk(layout) if node.get("id") == "sidebar-footer")
    footer["content"]["props"]["version"] = new
    if json.loads(new_layout) != layout:
        raise ValueError(f"{LAYOUT} changed beyond the sidebar-footer version")
    package_path.write_text(new_package)
    layout_path.write_text(new_layout)
    return new


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--since", help="Skip the bump if package.json's version differs at this revision")
    args = parser.parse_args(argv)
    print(bump(since=args.since))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, StopIteration, KeyError) as error:
        print(f"bump_version: {error}", file=sys.stderr)
        sys.exit(1)
