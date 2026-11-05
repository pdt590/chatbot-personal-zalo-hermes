"""Tests for hooks/zalo-tool-access.py (the Hermes pre_tool_call guard).

Run:  python -m unittest discover -s test
"""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "zalo-tool-access.py"
OWNER = "111"
STRANGER = "222"


class ToolAccessHookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "logs").mkdir()
        con = sqlite3.connect(self.home / "state.db")
        con.execute("create table sessions (id text primary key, source text, user_id text, chat_type text)")
        con.executemany("insert into sessions values (?,?,?,?)", [
            ("s-owner", "zalo", OWNER, "dm"), ("s-owner-group", "zalo", OWNER, "group"),
            ("s-stranger", "zalo", STRANGER, "dm"), ("s-cli", "cli", "uid:1000", None)])
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload, *extra_args, env=None):
        e = {k: v for k, v in os.environ.items() if not k.startswith(("HERMES_SESSION_", "ZALO_HOOK_"))}
        e.update(env or {})
        stdin = payload if isinstance(payload, str) else json.dumps(payload)
        p = subprocess.run([sys.executable, str(HOOK), "--profile-home", str(self.home),
                            "--owner", OWNER, *extra_args],
                           input=stdin, capture_output=True, text=True, env=e, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout) if p.stdout.strip() else None

    def assertBlocked(self, out):
        self.assertIsNotNone(out)
        self.assertEqual(out["action"], "block")

    def test_non_zalo_session_allowed(self):
        self.assertIsNone(self.run_hook({"tool_name": "terminal", "session_id": "s-cli"}))

    def test_stranger_blocked_even_for_read(self):
        self.assertBlocked(self.run_hook({"tool_name": "read_file", "session_id": "s-stranger",
                                          "tool_input": {"path": "/tmp"}}))

    def test_owner_read_allowed_write_blocked(self):
        self.assertIsNone(self.run_hook({"tool_name": "search_files", "session_id": "s-owner",
                                         "tool_input": {"path": "/tmp"}}))
        self.assertBlocked(self.run_hook({"tool_name": "terminal", "session_id": "s-owner"}))

    def test_owner_secret_path_blocked(self):
        for path in ("~/.ssh/id_rsa", "~/.hermes/config.yaml", "/srv/app/.env.local"):
            self.assertBlocked(self.run_hook({"tool_name": "read_file", "session_id": "s-owner",
                                              "tool_input": {"path": path}}))

    def test_owner_reads_inbound_attachments(self):
        home = Path.home() / ".hermes" / "zalo-hook-test-profile"
        docs = home / "cache" / "documents" / "x"
        docs.mkdir(parents=True, exist_ok=True)
        (home / "state.db").write_bytes((self.home / "state.db").read_bytes())
        try:
            run = lambda path: self.run_bare({"tool_name": "read_file", "session_id": "s-owner",
                                              "tool_input": {"path": str(path)}}, "--owner", OWNER,
                                             "--log", os.devnull, "--profile-home", str(home))
            self.assertIsNone(run(docs / "doc_1_test.txt"))
            self.assertBlocked(run(docs / ".env"))
            self.assertBlocked(run(home / "config.yaml"))
            self.assertBlocked(run(docs / ".." / ".." / ".." / "auth.json"))
        finally:
            import shutil
            shutil.rmtree(home, ignore_errors=True)

    def test_extra_tools_and_secret_paths(self):
        self.assertIsNone(self.run_hook({"tool_name": "web_search", "session_id": "s-owner"},
                                        "--extra-tools", "web_search"))
        self.assertBlocked(self.run_hook({"tool_name": "read_file", "session_id": "s-owner",
                                          "tool_input": {"path": "~/private/x.txt"}},
                                         "--secret-paths", "private"))

    def test_unknown_session_falls_back_to_env(self):
        self.assertBlocked(self.run_hook({"tool_name": "terminal", "session_id": "nope"}))
        self.assertIsNone(self.run_hook({"tool_name": "terminal", "session_id": "nope"},
                                        env={"HERMES_SESSION_PLATFORM": "cli"}))
        self.assertBlocked(self.run_hook({"tool_name": "terminal"}, env={
            "HERMES_SESSION_PLATFORM": "zalo", "HERMES_SESSION_USER_ID": STRANGER}))

    def test_fail_closed_on_bad_input_and_args(self):
        self.assertBlocked(self.run_hook("garbage"))
        self.assertBlocked(self.run_hook({"tool_name": "terminal", "session_id": "s-cli"}, "--bogus"))

    def test_no_owner_configured_blocks_all_zalo(self):
        e = {k: v for k, v in os.environ.items() if not k.startswith("ZALO_HOOK_")}
        p = subprocess.run([sys.executable, str(HOOK), "--profile-home", str(self.home)],
                           input=json.dumps({"tool_name": "read_file", "session_id": "s-owner"}),
                           capture_output=True, text=True, env=e, timeout=10)
        self.assertEqual(json.loads(p.stdout)["action"], "block")

    def test_owner_mode_full_dm(self):
        args = ("--owner-mode", "full-dm")
        self.assertIsNone(self.run_hook({"tool_name": "terminal", "session_id": "s-owner"}, *args))
        self.assertIsNone(self.run_hook({"tool_name": "read_file", "session_id": "s-owner",
                                         "tool_input": {"path": "~/.hermes/config.yaml"}}, *args))
        self.assertBlocked(self.run_hook({"tool_name": "read_file", "session_id": "s-owner",
                                          "tool_input": {"path": "~/.hermes/.env"}}, *args))
        self.assertBlocked(self.run_hook({"tool_name": "write_file", "session_id": "s-owner",
                                          "tool_input": {"path": "/x/auth.json"}}, *args))
        # groups stay read-only; strangers stay blocked; unknown chat type is not a DM
        self.assertBlocked(self.run_hook({"tool_name": "terminal", "session_id": "s-owner-group"}, *args))
        self.assertIsNone(self.run_hook({"tool_name": "read_file", "session_id": "s-owner-group",
                                         "tool_input": {"path": "/tmp"}}, *args))
        self.assertBlocked(self.run_hook({"tool_name": "terminal", "session_id": "s-stranger"}, *args))
        self.assertBlocked(self.run_hook({"tool_name": "terminal"}, *args, env={
            "HERMES_SESSION_PLATFORM": "zalo", "HERMES_SESSION_USER_ID": OWNER}))

    def test_owner_mode_full_and_bad_mode(self):
        self.assertIsNone(self.run_hook({"tool_name": "terminal", "session_id": "s-owner-group"},
                                        "--owner-mode", "full"))
        self.assertBlocked(self.run_hook({"tool_name": "terminal", "session_id": "s-owner"},
                                         "--owner-mode", "yolo"))
        (self.home / ".env").write_text("ZALO_HOOK_OWNER_MODE=full-dm\n")
        self.assertIsNone(self.run_hook({"tool_name": "terminal", "session_id": "s-owner"}))

    def test_env_vars_configure_owner(self):
        e = {k: v for k, v in os.environ.items() if not k.startswith(("ZALO_HOOK_", "HERMES_SESSION_"))}
        e.update(ZALO_HOOK_OWNERS=OWNER, ZALO_HOOK_PROFILE_HOME=str(self.home))
        p = subprocess.run([sys.executable, str(HOOK)],
                           input=json.dumps({"tool_name": "read_file", "session_id": "s-owner",
                                             "tool_input": {"path": "/tmp"}}),
                           capture_output=True, text=True, env=e, timeout=10)
        self.assertEqual(p.stdout.strip(), "")
        self.assertIn("ALLOW owner", (self.home / "logs" / "zalo-tool-access.log").read_text())

    def run_bare(self, payload, *args, env=None):
        e = {k: v for k, v in os.environ.items() if not k.startswith(("ZALO_HOOK_", "HERMES_SESSION_"))}
        e.update(env or {})
        p = subprocess.run([sys.executable, str(HOOK), "--profile-home", str(self.home), *args],
                           input=json.dumps(payload), capture_output=True, text=True, env=e, timeout=10)
        return json.loads(p.stdout) if p.stdout.strip() else None

    def test_profile_dotenv_configures_hook(self):
        (self.home / ".env").write_text(
            "# comment\nOPENAI_API_KEY=sk-x\n"
            f"export ZALO_HOOK_OWNERS=\"{OWNER},333\"\n"
            "ZALO_HOOK_EXTRA_TOOLS=web_search # inline comment\n"
            "ZALO_HOOK_SECRET_PATHS='private'\n")
        self.assertIsNone(self.run_bare({"tool_name": "web_search", "session_id": "s-owner"}))
        self.assertBlocked(self.run_bare({"tool_name": "read_file", "session_id": "s-owner",
                                          "tool_input": {"path": "~/private/a"}}))
        self.assertBlocked(self.run_bare({"tool_name": "read_file", "session_id": "s-stranger",
                                          "tool_input": {"path": "/tmp"}}))

    def test_args_and_process_env_override_dotenv(self):
        (self.home / ".env").write_text(f"ZALO_HOOK_OWNERS={STRANGER}\n")
        ok = {"tool_name": "read_file", "session_id": "s-owner", "tool_input": {"path": "/tmp"}}
        self.assertBlocked(self.run_bare(ok))
        self.assertIsNone(self.run_bare(ok, env={"ZALO_HOOK_OWNERS": OWNER}))
        self.assertIsNone(self.run_bare(ok, "--owner", OWNER))


if __name__ == "__main__":
    unittest.main()
