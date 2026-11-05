#!/usr/bin/env python3
"""Hermes ``pre_tool_call`` shell hook: limit what Zalo users can make the agent do.

Fails closed. Install it per Hermes profile; see "Tool access hook" in README.md.

The gateway runs multiplexed, so HERMES_SESSION_* env vars are not reliably
present in the hook process. The platform and sender are resolved from the
payload's session_id via the profile's state.db (sessions.source/user_id).

Policy:
  - Zalo, non-owner  -> every tool blocked.
  - Zalo, owner      -> read-only tools only; reads of secret paths blocked.
  - Not Zalo (cli/tui/desktop/cron...) -> allowed (normal Hermes policy).
  - Session not in state.db -> fall back to HERMES_SESSION_PLATFORM/USER_ID env;
    if neither is available -> blocked.
  - Any error (bad payload, bad arguments, exception) -> blocked.

Settings come from command-line arguments, then ZALO_HOOK_* env vars, then defaults:
  --owner ID[,ID]        ZALO_HOOK_OWNERS         Zalo uids treated as owner (none = nobody)
  --profile-home PATH    ZALO_HOOK_PROFILE_HOME   Hermes profile dir (default: parent of this
                                                  script's dir, i.e. <profile>/agent-hooks/..)
  --owner-tools a,b      ZALO_HOOK_OWNER_TOOLS    replace the owner's read-only tool list
  --extra-tools a,b      ZALO_HOOK_EXTRA_TOOLS    add tools to the owner's list
  --secret-paths p,q     ZALO_HOOK_SECRET_PATHS   extra paths (relative to ~ or absolute) to protect
  --log PATH             ZALO_HOOK_LOG            log file (default: <profile>/logs/zalo-tool-access.log)
"""

import argparse
import json
import os
import sqlite3
import sys
import time

DEFAULT_OWNER_TOOLS = (
    "read_file", "search_files", "vision_analyze", "todo_list",
    "tool_search", "tool_describe", "clarify",
    # hermes-zalo-plugin `zalo_groups` toolset (read-only): group stats and logged messages.
    "zalo_group_stats", "zalo_group_messages",
)
PATH_TOOLS = {"read_file", "search_files", "vision_analyze"}
HOME = os.path.expanduser("~")
DEFAULT_SECRET_DIRS = (
    ".hermes", ".hermes-zalo", ".ssh", ".gnupg", ".config", ".npm-global", ".aws", ".docker",
    ".local/share/keyrings", ".mozilla", ".pki",
)
SECRET_NAMES = {".env", "auth.json", "config.json", "credentials", "credentials.json",
                "bridge.env", "id_rsa", "id_ed25519"}

MSG_DENY = ("Tài khoản Zalo này chỉ được hỏi đáp thông tin thông thường và không có quyền "
            "sử dụng công cụ, truy cập hệ thống hoặc thực hiện hành động.")
MSG_UNVERIFIED = "Không thể xác minh quyền sử dụng công cụ."

LOG = None  # set by configure(); log() is a no-op until then


def log(line: str) -> None:
    if not LOG:
        return
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
    except Exception:
        pass


def block(msg: str, why: str) -> None:
    log(f"BLOCK {why}")
    print(json.dumps({"action": "block", "message": msg}, ensure_ascii=False))
    sys.exit(0)


def split_list(value) -> list:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # fail closed on bad configuration
        block(MSG_UNVERIFIED, f"bad-arguments {message}")


def configure(argv):
    global LOG
    p = _Parser(add_help=False)
    p.add_argument("--owner", action="append", default=[])
    p.add_argument("--profile-home")
    p.add_argument("--owner-tools")
    p.add_argument("--extra-tools", action="append", default=[])
    p.add_argument("--secret-paths", action="append", default=[])
    p.add_argument("--log")
    a = p.parse_args(argv)
    env = os.environ.get

    home = a.profile_home or env("ZALO_HOOK_PROFILE_HOME") \
        or os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    home = os.path.realpath(os.path.expanduser(home))
    LOG = os.path.expanduser(a.log or env("ZALO_HOOK_LOG")
                             or os.path.join(home, "logs", "zalo-tool-access.log"))

    owners = set(split_list(",".join(a.owner)) or split_list(env("ZALO_HOOK_OWNERS")))
    tools = set(split_list(a.owner_tools or env("ZALO_HOOK_OWNER_TOOLS")) or DEFAULT_OWNER_TOOLS)
    tools |= set(split_list(",".join(a.extra_tools)) or split_list(env("ZALO_HOOK_EXTRA_TOOLS")))
    extra_secrets = split_list(",".join(a.secret_paths)) or split_list(env("ZALO_HOOK_SECRET_PATHS"))
    secret_prefixes = tuple(os.path.realpath(os.path.join(HOME, os.path.expanduser(s)))
                            for s in (*DEFAULT_SECRET_DIRS, *extra_secrets))
    return {"state_db": os.path.join(home, "state.db"), "owners": owners,
            "tools": tools, "secret_prefixes": secret_prefixes}


def lookup(state_db: str, session_id: str):
    if not session_id:
        return None
    con = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=3)
    try:
        return con.execute("select source, user_id from sessions where id=?", (session_id,)).fetchone()
    finally:
        con.close()


def secret_path(path: str, cwd: str, prefixes) -> bool:
    p = os.path.expanduser(path or ".")
    if not os.path.isabs(p):
        p = os.path.join(cwd or HOME, p)
    real = os.path.realpath(p)
    if any(real == s or real.startswith(s + os.sep) for s in prefixes):
        return True
    return any(part in SECRET_NAMES or part.startswith(".env") for part in real.split(os.sep))


def main(argv) -> None:
    cfg = configure(argv)
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("payload is not an object")
    except Exception:
        block(MSG_UNVERIFIED, "bad-payload")

    tool = str(payload.get("tool_name") or "")
    args = payload.get("tool_input") or {}
    if not isinstance(args, dict):
        args = {}
    sid = str(payload.get("session_id") or "")
    env_platform = (os.environ.get("HERMES_SESSION_PLATFORM") or "").strip().lower()
    env_user = (os.environ.get("HERMES_SESSION_USER_ID") or "").strip()

    try:
        row = lookup(cfg["state_db"], sid)
    except Exception as exc:
        row = None
        log(f"db-error sid={sid} {exc!r}")

    if row:
        source, user_id = (row[0] or "").lower(), str(row[1] or "")
    elif env_platform:
        source, user_id = env_platform, env_user
    else:
        block(MSG_UNVERIFIED, f"unknown-session sid={sid} tool={tool}")

    if source != "zalo":
        return

    if user_id not in cfg["owners"]:
        block(MSG_DENY, f"non-owner user={user_id} sid={sid} tool={tool}")

    if tool not in cfg["tools"]:
        block(f"Trên Zalo chỉ được dùng công cụ đọc. `{tool}` hãy dùng qua CLI/TUI.",
              f"owner-nonread sid={sid} tool={tool}")

    if tool in PATH_TOOLS:
        target = args.get("path") or args.get("image_url") or args.get("image_path") or "."
        if isinstance(target, str) and not target.startswith(("http://", "https://", "data:")) \
                and secret_path(target, payload.get("cwd") or "", cfg["secret_prefixes"]):
            block("Đường dẫn này chứa cấu hình/bí mật, không được đọc qua Zalo.",
                  f"owner-secret sid={sid} tool={tool} path={target}")
    log(f"ALLOW owner sid={sid} tool={tool}")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except SystemExit:
        raise
    except Exception as exc:  # fail closed
        block(MSG_UNVERIFIED, f"exception {exc!r}")
