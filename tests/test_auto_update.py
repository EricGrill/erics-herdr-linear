"""Automatic-update tests use a local bare origin and disposable homes; no network, no services."""
import contextlib
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("herdr_auto_update", ROOT / "scripts/auto_update.py")
auto = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auto)

STUB_INSTALL = '''import json, os, subprocess, sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
home = Path(os.environ["HERDR_APP_HOME"])
commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
(home / "layouts").mkdir(parents=True, exist_ok=True)
(home / "layouts/erics-linear.json").write_text((root / "layouts/erics-linear.json").read_text())
(home / ".erics-linear-install.json").write_text(json.dumps(
    {"git_commit": commit, "selected": "--select" in sys.argv, "checks": "passed", "args": sys.argv[1:]}))
'''


def layout(version):
    return json.dumps({"id": "root", "children": [
        {"id": "sidebar-footer", "content": {"props": {"version": version}}}]})


class AutoUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.origin, self.seed, self.checkout = base / "origin.git", base / "seed", base / "checkout"
        self.home = base / "herdr"
        self.home.mkdir()
        self.state = base / "state"
        env = {"XDG_STATE_HOME": str(self.state), "HERDR_APP_HOME": str(self.home),
               "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
               "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid",
               "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        mock.patch.dict(os.environ, env).start()
        self.addCleanup(mock.patch.stopall)
        self.git(base, "init", "-q", "--bare", "-b", "main", str(self.origin))
        self.git(base, "init", "-q", "-b", "main", str(self.seed))
        (self.seed / "scripts").mkdir()
        (self.seed / "layouts").mkdir()
        shutil.copy(ROOT / "scripts/update.sh", self.seed / "scripts/update.sh")
        (self.seed / "scripts/install.py").write_text(STUB_INSTALL)
        self.v1 = self.commit("0.1.0")
        self.git(self.seed, "remote", "add", "origin", str(self.origin))
        self.git(self.seed, "push", "-q", "origin", "main")
        self.git(base, "clone", "-q", str(self.origin), str(self.checkout))
        mock.patch.object(auto, "REPO", self.checkout).start()
        self.reports = []
        self.report_ok = True
        mock.patch.object(auto, "report_status",
                          side_effect=lambda *a: self.reports.append(a) or self.report_ok).start()
        self.notes = []
        mock.patch.object(auto, "notify", side_effect=lambda *a: self.notes.append(a)).start()
        self.running = mock.patch.object(auto, "herdr_running", return_value=False).start()
        mock.patch.object(auto, "machine_name", return_value="testbox").start()

    def git(self, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, version):
        (self.seed / "layouts/erics-linear.json").write_text(layout(version))
        self.git(self.seed, "add", ".")
        self.git(self.seed, "commit", "-qm", f"release {version}")
        return self.git(self.seed, "rev-parse", "HEAD")

    def publish(self, version, deploy=True):
        commit = self.commit(version)
        self.git(self.seed, "push", "-q", "origin", "main")
        if deploy:
            self.git(self.seed, "push", "-q", "origin", f"{commit}:refs/heads/deploy")
        return commit

    def run_update(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return auto.run()

    def receipt(self):
        path = self.home / ".erics-linear-install.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def test_without_deploy_branch_nothing_is_installed(self):
        self.publish("0.1.1", deploy=False)
        self.assertEqual(0, self.run_update())
        self.assertEqual({}, self.receipt())
        self.assertEqual([], self.reports)

    def test_installs_deploy_commit_and_reports_version_once(self):
        target = self.publish("0.1.1")
        self.assertEqual(0, self.run_update())
        self.assertEqual(target, self.receipt()["git_commit"])
        self.assertEqual(target, self.git(self.checkout, "rev-parse", "HEAD"))
        self.assertEqual(1, len(self.reports))
        commit, state, description = self.reports[0]
        self.assertEqual((target, "success"), (commit, state))
        self.assertIn("v0.1.1", description)
        self.assertIn(target[:7], description)
        self.assertEqual(0, self.run_update())
        self.assertEqual(1, len(self.reports), "an unchanged deploy is not reported again")

    def test_failed_status_report_is_retried_but_alert_is_sent_once(self):
        target = self.publish("0.1.1")
        (self.checkout / "layouts/erics-linear.json").write_text("local edit")
        self.report_ok = False
        self.assertEqual(1, self.run_update())
        self.assertEqual(1, self.run_update())
        self.assertEqual(2, len(self.reports), "a status gh rejected is retried on the next run")
        self.assertEqual(1, len(self.notes), "the alert is not repeated while the report is retried")
        self.report_ok = True
        self.assertEqual(1, self.run_update())
        self.assertEqual(3, len(self.reports))
        self.assertEqual(1, self.run_update())
        self.assertEqual(3, len(self.reports), "once accepted, the same outcome is not reported again")
        self.assertTrue(all(r[:2] == (target, "failure") for r in self.reports))
        self.assertEqual(1, len(self.notes))

    def test_unverified_main_commit_is_not_installed(self):
        verified = self.publish("0.1.1")
        self.publish("0.1.2", deploy=False)
        self.assertEqual(0, self.run_update())
        self.assertEqual(verified, self.receipt()["git_commit"])
        self.assertEqual(verified, self.git(self.checkout, "rev-parse", "HEAD"))

    def test_local_changes_skip_without_overwriting_and_alert_once(self):
        target = self.publish("0.1.1")
        (self.checkout / "layouts/erics-linear.json").write_text("local edit")
        self.assertEqual(1, self.run_update())
        self.assertEqual(1, self.run_update())
        self.assertEqual("local edit", (self.checkout / "layouts/erics-linear.json").read_text())
        self.assertEqual(self.v1, self.git(self.checkout, "rev-parse", "HEAD"))
        self.assertEqual({}, self.receipt())
        self.assertEqual(1, len(self.reports))
        self.assertEqual((target, "failure"), self.reports[0][:2])
        self.assertIn("local changes", self.reports[0][2])
        self.assertEqual(1, len(self.notes))
        (self.checkout / "layouts/erics-linear.json").write_text(layout("0.1.0"))
        self.assertEqual(0, self.run_update(), "a cleaned checkout catches up on the next run")
        self.assertEqual(target, self.receipt()["git_commit"])

    def test_other_branch_is_skipped(self):
        self.publish("0.1.1")
        self.git(self.checkout, "checkout", "-q", "-b", "experiment")
        self.assertEqual(1, self.run_update())
        self.assertIn("not main", self.reports[0][2])
        self.assertEqual(self.v1, self.git(self.checkout, "rev-parse", "HEAD"))

    def test_local_commits_not_on_deploy_are_skipped(self):
        self.publish("0.1.1")
        (self.checkout / "local.txt").write_text("x")
        self.git(self.checkout, "add", ".")
        self.git(self.checkout, "commit", "-qm", "local")
        self.assertEqual(1, self.run_update())
        self.assertIn("not on deploy", self.reports[0][2])

    def test_checkout_ahead_of_deploy_waits_quietly(self):
        verified = self.publish("0.1.1")
        newer = self.publish("0.1.2", deploy=False)
        self.git(self.checkout, "pull", "-q", "--ff-only")
        self.assertEqual(0, self.run_update())
        self.assertEqual([], self.reports)
        self.git(self.seed, "push", "-q", "origin", f"{newer}:refs/heads/deploy")
        self.assertEqual(0, self.run_update())
        self.assertEqual(newer, self.receipt()["git_commit"])
        self.assertNotEqual(verified, newer)

    def test_select_only_when_herdr_is_running(self):
        self.publish("0.1.1")
        self.run_update()
        self.assertNotIn("--select", self.receipt()["args"])
        self.running.return_value = True
        self.publish("0.1.2")
        self.run_update()
        self.assertEqual(["--update", "--select"], self.receipt()["args"])
        self.assertTrue(self.receipt()["selected"])

    def test_failed_install_is_reported_as_error(self):
        target = self.publish("0.1.1")
        (self.seed / "scripts/install.py").write_text("import sys\nsys.exit('Install did not complete: boom')\n")
        broken = self.publish("0.1.2")
        self.assertEqual(1, self.run_update())
        self.assertNotEqual(target, broken)
        self.assertEqual((broken, "error"), self.reports[-1][:2])
        self.assertIn("boom", self.reports[-1][2])
        self.assertEqual(1, len(self.notes))

    def test_offline_machine_retries_and_alerts_after_a_day(self):
        self.publish("0.1.1")
        self.assertEqual(0, self.run_update())
        self.origin.rename(self.origin.with_name("gone.git"))
        self.assertEqual(1, self.run_update())
        self.assertEqual([], [n for n in self.notes if "not updating" in n[0]])
        state_path = self.state / "erics-herdr-linear/state.json"
        state = json.loads(state_path.read_text())
        old = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=30)
        state["last_fetch_ok"] = old.isoformat()
        state_path.write_text(json.dumps(state))
        self.run_update()
        self.run_update()
        self.assertEqual(1, len([n for n in self.notes if "not updating" in n[0]]))
        self.origin.with_name("gone.git").rename(self.origin)
        target = self.publish("0.1.2")
        self.assertEqual(0, self.run_update(), "back online, it catches up")
        self.assertEqual(target, self.receipt()["git_commit"])

    def test_update_script_to_refuses_non_fast_forward(self):
        self.git(self.checkout, "checkout", "-q", "-b", "side", self.v1)
        (self.checkout / "side.txt").write_text("x")
        self.git(self.checkout, "add", ".")
        self.git(self.checkout, "commit", "-qm", "side")
        target = self.publish("0.1.1")
        self.git(self.checkout, "fetch", "-q", "origin")
        result = subprocess.run(["bash", str(self.checkout / "scripts/update.sh"), "--to", target],
                                capture_output=True, text=True)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual({}, self.receipt())

    def test_service_files_run_the_updater_from_this_checkout(self):
        for system in ("Darwin", "Linux"):
            with mock.patch.object(auto.platform, "system", return_value=system):
                files = auto.service_files(300)
            text = "\n".join(files.values())
            self.assertIn(str(self.checkout / "scripts/auto_update.py"), text)
            self.assertIn("/opt/homebrew/bin", text)
            self.assertTrue(any("300" in t for t in files.values()))


if __name__ == "__main__":
    unittest.main()
