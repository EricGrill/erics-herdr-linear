"""Installer integration tests use disposable homes and never contact another machine."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("herdr_install", ROOT / "scripts/install.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.source = base / "checkout"
        self.home = base / "herdr"
        self.home.mkdir()
        (self.home / "AGENTS.md").write_text("Herdr fixture\n")
        for name in ("pane", "files", "changes", "workspace-status", "workspace-chrome"):
            path = self.home / "mods" / name / "main.js"
            path.parent.mkdir(parents=True)
            path.write_text("// shipped fixture\n")
        for name in installer.MODS:
            folder = self.source / "mods" / name
            folder.mkdir(parents=True)
            (folder / "main.js").write_text('// fixture · ⌘⌥A\n')
            (folder / "mod.json").write_text('{"place":"none"}\n')
            (folder / "icon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
            (folder / "private-cache.json").write_text('{"private":"do not distribute"}')
            (folder / "screenshot.png").write_bytes(b"private screenshot fixture")
            (folder / "test.test.mjs").write_text("// test source is not runtime\n")
        (self.source / "layouts").mkdir()
        (self.source / "layouts/erics-linear.json").write_text('{"id":"root","type":"row"}\n')
        (self.source / "layouts/erics-linear.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        (self.source / "LICENSE").write_text("License fixture\n")
        (self.source / "THIRD_PARTY_NOTICES.md").write_text("Notices fixture\n")
        (self.source / "licenses").mkdir()
        (self.source / "licenses/upstream.txt").write_text("Upstream license fixture\n")
        self.before_keys = {"global": {"ctrl-q": "app.quit"}, "terminal": {"ctrl-c": "terminal"},
                            "layout:other": {"f8": "app.help"}}
        (self.home / "keys.json").write_text(json.dumps(self.before_keys))
        for name in ("settings.json", "shared.json", "view.json", "window.json"):
            (self.home / name).write_bytes(b'{"machine_local":"preserve exactly"}\n')
        (self.home / "data").mkdir()
        (self.home / "data/account.txt").write_bytes(b"private fixture state")
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(installer, "SOURCE_ROOT", self.source).start()
        mock.patch.object(installer, "find_herdr", return_value=None).start()
        mock.patch.object(installer.platform, "system", return_value="Darwin").start()

    def run_install(self, *options):
        with contextlib.redirect_stdout(io.StringIO()):
            return installer.install(["--home", str(self.home), "--skip-checks", *options])

    def snapshot(self):
        return {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob("*") if p.is_file()}

    def test_dry_run_does_not_write_any_files(self):
        before = self.snapshot()
        self.run_install("--dry-run")
        self.assertEqual(before, self.snapshot())
        self.assertFalse((self.home / "backups").exists())

    def test_install_preserves_machine_state_and_other_shortcut_sections(self):
        before = self.snapshot()
        self.run_install()
        for relative in ("settings.json", "shared.json", "view.json", "window.json", "data/account.txt"):
            self.assertEqual(before[relative], (self.home / relative).read_bytes())
        keys = json.loads((self.home / "keys.json").read_text())
        for section, bindings in self.before_keys.items():
            self.assertEqual(bindings, keys[section])
        self.assertEqual(installer.MAC_KEYS, keys[installer.SCOPE])

    def test_legacy_linear_shortcut_moves_to_api_key_browser_with_backup(self):
        self.before_keys["global"]["cmd-l"] = "mod.open:EricsLinear"
        original = json.dumps(self.before_keys)
        (self.home / "keys.json").write_text(original)
        self.run_install()
        keys = json.loads((self.home / "keys.json").read_text())
        self.assertEqual("mod.open:linear-board", keys["global"]["cmd-l"])
        self.assertEqual("app.quit", keys["global"]["ctrl-q"])
        receipt = json.loads((self.home / installer.RECEIPT_NAME).read_text())
        self.assertEqual(original, (Path(receipt["backup"]) / "keys.json").read_text())
        self.run_install("--update")
        self.assertEqual(keys, json.loads((self.home / "keys.json").read_text()))

    def test_custom_linear_shortcut_is_preserved(self):
        self.before_keys["global"]["cmd-l"] = "my.custom-action"
        (self.home / "keys.json").write_text(json.dumps(self.before_keys))
        self.run_install()
        keys = json.loads((self.home / "keys.json").read_text())
        self.assertEqual(self.before_keys["global"], keys["global"])

    def test_only_runtime_files_and_license_notices_are_installed(self):
        self.run_install()
        for name in installer.MODS:
            folder = self.home / "mods" / name
            self.assertTrue((folder / "main.js").is_file())
            self.assertTrue((folder / "icon.svg").is_file())
            self.assertFalse((folder / "private-cache.json").exists())
            self.assertFalse((folder / "screenshot.png").exists())
            self.assertFalse((folder / "test.test.mjs").exists())
        self.assertTrue((self.home / "licenses/erics-herdr-linear/LICENSE").is_file())
        self.assertTrue((self.home / "licenses/erics-herdr-linear/licenses/upstream.txt").is_file())

    def test_existing_machine_config_is_unchanged_without_explicit_config(self):
        config = b'{"enrichment":{"enabled":false},"attention":{"labels":[]}}\n'
        (self.home / installer.CONFIG_NAME).write_bytes(config)
        self.run_install()
        self.assertEqual(config, (self.home / installer.CONFIG_NAME).read_bytes())

    def test_existing_install_requires_update_without_changing_any_files(self):
        self.run_install()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "--update"):
            self.run_install()
        self.assertEqual(before, self.snapshot())

    def test_update_backs_changed_source_and_keeps_unmanaged_files(self):
        self.run_install()
        target = self.home / "mods/linear-board/main.js"
        original = target.read_bytes()
        (target.parent / "user-notes.txt").write_text("keep me")
        (self.source / "mods/linear-board/main.js").write_text("// newer source\n")
        self.run_install("--update")
        receipt = json.loads((self.home / installer.RECEIPT_NAME).read_text())
        self.assertEqual(original, (Path(receipt["backup"]) / "mods/linear-board/main.js").read_bytes())
        self.assertEqual("// newer source\n", target.read_text())
        self.assertEqual("keep me", (target.parent / "user-notes.txt").read_text())

    def test_custom_layout_shortcut_conflict_fails_before_writes(self):
        keys = {**self.before_keys, installer.SCOPE: {"cmd-alt-a": "my.custom-action"}}
        (self.home / "keys.json").write_text(json.dumps(keys))
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "custom bindings"):
            self.run_install()
        self.assertEqual(before, self.snapshot())

    def test_terminal_shortcuts_are_not_overwritten_or_silently_shadowed(self):
        keys = {**self.before_keys, "terminal": {"cmd-alt-a": "terminal"}}
        (self.home / "keys.json").write_text(json.dumps(keys))
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "Terminal bindings"):
            self.run_install()
        self.assertEqual(before, self.snapshot())

    def test_explicit_config_is_validated_written_first_and_backed_up(self):
        old = b'{"enrichment":{"enabled":false}}\n'
        new = b'{"enrichment":{"envKey":"MY_LINEAR_KEY"}}\n'
        (self.home / installer.CONFIG_NAME).write_bytes(old)
        supplied = Path(self.temp.name) / "preferences.json"
        supplied.write_bytes(new)
        writes = []
        real_write = installer.atomic_write
        def record(path, data, mode=None):
            writes.append(path.relative_to(self.home).as_posix())
            return real_write(path, data, mode)
        with mock.patch.object(installer, "atomic_write", side_effect=record):
            self.run_install("--config", str(supplied))
        self.assertEqual(installer.CONFIG_NAME, writes[0])
        self.assertEqual(new, (self.home / installer.CONFIG_NAME).read_bytes())
        self.assertEqual(0o600, (self.home / installer.CONFIG_NAME).stat().st_mode & 0o777)
        receipt = json.loads((self.home / installer.RECEIPT_NAME).read_text())
        self.assertEqual(old, (Path(receipt["backup"]) / installer.CONFIG_NAME).read_bytes())

    def test_config_rejects_secret_value_fields_before_writes(self):
        supplied = Path(self.temp.name) / "bad.json"
        supplied.write_text('{"enrichment":{"apiKey":"fake-test-credential"}}')
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "not key values"):
            self.run_install("--config", str(supplied))
        self.assertEqual(before, self.snapshot())

    def test_linux_uses_its_scoped_shortcuts_and_native_hint(self):
        with mock.patch.object(installer.platform, "system", return_value="Linux"):
            self.run_install()
        keys = json.loads((self.home / "keys.json").read_text())
        self.assertEqual(installer.LINUX_KEYS, keys[installer.SCOPE])
        self.assertIn("Alt+Shift+A", (self.home / "mods/erics-linear-agents/main.js").read_text())

    def test_managed_symlink_is_rejected_without_touching_its_destination(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "private.txt").write_text("keep")
        (self.home / "mods/linear-board").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.run_install("--update")
        self.assertEqual(["private.txt"], sorted(p.name for p in outside.iterdir()))

    def test_receipt_records_source_commit_and_installed_hashes(self):
        subprocess.run(["git", "init", "-q", str(self.source)], check=True)
        subprocess.run(["git", "-C", str(self.source), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.source), "-c", "user.name=Installer Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Test fixture"], check=True)
        commit = subprocess.check_output(["git", "-C", str(self.source), "rev-parse", "HEAD"], text=True).strip()
        self.run_install()
        receipt = json.loads((self.home / installer.RECEIPT_NAME).read_text())
        self.assertEqual(str(self.source), receipt["source"])
        self.assertEqual(commit, receipt["git_commit"])
        self.assertFalse(receipt["git_dirty"])
        self.assertEqual("skipped", receipt["checks"])
        self.assertFalse(receipt["selected"])
        self.assertIn("mods/linear-board/main.js", receipt["files"])

    def test_select_without_cli_does_not_claim_activation_or_write_files(self):
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "Cannot select"):
            self.run_install("--select")
        self.assertEqual(before, self.snapshot())

    def test_update_script_refuses_dirty_checkout_before_pull(self):
        (self.source / "scripts").mkdir()
        shutil_source = ROOT / "scripts/update.sh"
        (self.source / "scripts/update.sh").write_bytes(shutil_source.read_bytes())
        subprocess.run(["git", "init", "-q", str(self.source)], check=True)
        result = subprocess.run(["bash", str(self.source / "scripts/update.sh")], capture_output=True, text=True)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("local changes", result.stderr)
        self.assertNotIn("no tracking", result.stderr)


if __name__ == "__main__":
    unittest.main()
