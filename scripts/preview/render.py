#!/usr/bin/env python3
"""Regenerate the public preview images from scripts/preview/*.html.

Optional authoring tool. Nothing in the install, update or CI path needs it; the
rendered PNGs are committed. Requires Google Chrome and macOS `sips`, and renders at
2x before downsampling so text stays crisp.

    python3 scripts/preview/render.py

Everything it draws is demonstration data. Never point it at a real workspace.
"""
import argparse
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SCALE = 2

# (source html, theme attribute or None, output path, width, height)
TARGETS = [
    ("preview.html", "light", ROOT / "preview.png", 1600, 1000),
    ("preview.html", "dark", ROOT / "preview-dark.png", 1600, 1000),
    ("social.html", None, ROOT / ".github" / "social-preview.png", 1280, 640),
]


def render(source: str, theme: str | None, out: pathlib.Path, width: int, height: int) -> None:
    html = (HERE / source).read_text()
    if theme:
        html = html.replace('<html lang="en" data-theme="light">', f'<html lang="en" data-theme="{theme}">')
        if f'data-theme="{theme}"' not in html:
            raise SystemExit(f"{source}: could not set theme {theme}")
    with tempfile.TemporaryDirectory() as tmp:
        page = pathlib.Path(tmp) / source
        page.write_text(html)
        shot = pathlib.Path(tmp) / "shot.png"
        subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             f"--force-device-scale-factor={SCALE}",
             f"--window-size={width},{height}",
             f"--screenshot={shot}", page.as_uri()],
            check=True, capture_output=True,
        )
        if not shot.is_file():
            raise SystemExit(f"{source}: Chrome produced no screenshot")
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["sips", "--resampleWidth", str(width), str(shot), "--out", str(out)],
                       check=True, capture_output=True)
    print(f"{out.relative_to(ROOT)}  {width}x{height}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome", default=CHROME, help="path to a Chrome binary")
    args = parser.parse_args()
    globals()["CHROME"] = args.chrome
    if not pathlib.Path(args.chrome).exists() and not shutil.which(args.chrome):
        print(f"Chrome not found at {args.chrome}; pass --chrome PATH.", file=sys.stderr)
        return 1
    for source, theme, out, width, height in TARGETS:
        render(source, theme, out, width, height)
    return 0


if __name__ == "__main__":
    sys.exit(main())
