"""Version bump tests run on a disposable copy of the release files; no network."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("herdr_bump_version", ROOT / "scripts/bump_version.py")
bump = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bump)


class BumpVersionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "layouts").mkdir()
        shutil.copy(ROOT / "package.json", self.root / "package.json")
        shutil.copy(ROOT / "layouts/erics-linear.json", self.root / "layouts/erics-linear.json")
        self.start = json.loads((self.root / "package.json").read_text())["version"]

    def git(self, *args):
        env = {**os.environ, "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@example.invalid",
               "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@example.invalid",
               "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, env=env)

    def versions(self):
        package = json.loads((self.root / "package.json").read_text())["version"]
        layout = json.loads((self.root / "layouts/erics-linear.json").read_text())
        return package, bump.footer_version(layout)

    def test_next_patch(self):
        self.assertEqual("0.1.2", bump.next_patch("0.1.1"))
        self.assertEqual("1.0.10", bump.next_patch("1.0.9"))
        with self.assertRaises(ValueError):
            bump.next_patch("0.1.1-beta")

    def test_bumps_package_and_footer_together_and_nothing_else(self):
        before = {name: (self.root / name).read_text() for name in ("package.json", "layouts/erics-linear.json")}
        new = bump.bump(self.root)
        self.assertEqual(bump.next_patch(self.start), new)
        self.assertEqual((new, new), self.versions())
        for name, text in before.items():
            after = (self.root / name).read_text().splitlines()
            changed = [i for i, (a, b) in enumerate(zip(text.splitlines(), after)) if a != b]
            self.assertEqual(1, len(changed), f"{name}: only the version line changes")
            self.assertEqual(len(text.splitlines()), len(after))
        layout = json.loads((self.root / "layouts/erics-linear.json").read_text())
        self.assertEqual(json.loads(before["layouts/erics-linear.json"])["cloned_from"], layout["cloned_from"])
        self.assertEqual(bump.next_patch(new), bump.bump(self.root), "each run raises it again")

    def test_since_skips_a_merge_that_set_the_version_by_hand(self):
        self.git("init", "-q")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.assertEqual(bump.next_patch(self.start), bump.bump(self.root, since="HEAD"),
                         "unchanged since HEAD: bump")
        self.git("commit", "-qam", "manual minor release")
        self.assertEqual(self.versions()[0], bump.bump(self.root, since="HEAD~1"),
                         "version already changed in the merge: release it as it is")
        self.assertEqual(self.versions()[0], bump.next_patch(self.start))

    def test_mismatched_versions_are_refused(self):
        path = self.root / "package.json"
        path.write_text(path.read_text().replace(f'"version": "{self.start}"', '"version": "9.9.9"'))
        with self.assertRaises(ValueError):
            bump.bump(self.root)


if __name__ == "__main__":
    unittest.main()
