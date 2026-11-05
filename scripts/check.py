#!/usr/bin/env python3
"""Check release structure and native assets without opening apps or reading credentials."""
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

root = pathlib.Path(__file__).resolve().parents[1]
required = ["README.md", "RECIPE.md", "preview.png", "LICENSE", "THIRD_PARTY_NOTICES.md",
            "layouts/erics-linear.json", "layouts/erics-linear.svg", "scripts/install.py",
            "scripts/update.sh", "scripts/sync.sh", "scripts/auto_update.py"]
errors = [f"Missing {name}" for name in required if not (root / name).is_file()]

def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)

try:
    layout = json.loads((root / "layouts/erics-linear.json").read_text())
    nodes = list(walk(layout))
    ids = [node["id"] for node in nodes]
    if len(ids) != len(set(ids)):
        errors.append("Duplicate layout IDs")
    version = json.loads((root / "package.json").read_text())["version"]
    footer = next(node for node in nodes if node["id"] == "sidebar-footer")
    if footer.get("content", {}).get("props", {}).get("version") != version:
        errors.append("Sidebar footer version must match package.json")
except (OSError, ValueError, KeyError, StopIteration) as error:
    errors.append(f"Layout: {error}")

for path in list((root / "mods").rglob("*.json")) + list((root / "layouts").glob("*.json")):
    try:
        json.loads(path.read_text())
    except ValueError as error:
        errors.append(f"{path.relative_to(root)}: {error}")
for path in root.rglob("*.svg"):
    if ".git" in path.parts:
        continue
    try:
        ET.parse(path)
    except ET.ParseError as error:
        errors.append(f"{path.relative_to(root)}: {error}")
for path in (root / "mods").rglob("*.js"):
    text = path.read_text()
    for match in re.finditer(r'from\s+["\'](\./[^"\']+)["\']', text):
        if not (path.parent / match.group(1)).is_file():
            errors.append(f"Missing import {match.group(1)} in {path.relative_to(root)}")
    if re.search(r'export const DOPPLER_PROJECT\s*=\s*["\'][^"\']+["\']', text):
        errors.append(f"Hardcoded credential-provider project: {path.relative_to(root)}")

for name in ("shared.json", "view.json", "settings.json", "linear-cache.json", "erics-linear.config.json"):
    if (root / name).exists():
        errors.append(f"Machine-local state must not be in this checkout: {name}")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print("Release structure, layout IDs, module imports and SVGs are valid.")
