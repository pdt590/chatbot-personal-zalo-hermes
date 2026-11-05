#!/usr/bin/env python3
"""Hermes ``pre_tool_call`` shell hook: limit what Zalo users can make the agent do.

Fails closed. Install it per Hermes profile; see "Tool access hook" in README.md.

The gateway runs multiplexed, so HERMES_SESSION_* env vars are not reliably
present in the hook process. The platform and sender are resolved from the
payload's session_id via the profile's state.db (sessions.source/user_id).

Policy:
  - Zalo, non-owner  -> every tool blocked.
  - Zalo, owner      -> depends on the owner mode:
      read    (default) read-only tools only; reads of secret paths blocked.
      full-dm every tool in a 1-1 chat (read-only in groups, where other members'
              messages share the context); only credential files (.env, auth.json,
              id_rsa...) are off limits to file tools.
      full    like full-dm, in groups too.
  - Not Zalo (cli/tui/desktop/cron...) -> allowed (normal Hermes policy).
  - Session not in state.db -> fall back to HERMES_SESSION_PLATFORM/USER_ID env;
    if neither is available -> blocked.
  - Any error (bad payload, bad arguments, exception) -> blocked.

Settings come from command-line arguments, then ZALO_HOOK_* env vars of the hook
process, then ZALO_HOOK_* lines in the profile's .env, then defaults. The .env is read
by this script directly: a multiplexed gateway keeps profile .env values out of the
hook's environment. ZALO_HOOK_PROFILE_HOME cannot come from .env (it locates the .env).
  --owner ID[,ID]        ZALO_HOOK_OWNERS         Zalo uids treated as owner (none = nobody)
  --profile-home PATH    ZALO_HOOK_PROFILE_HOME   Hermes profile dir (default: parent of this
                                                  script's dir, i.e. <profile>/agent-hooks/..)
  --owner-mode M         ZALO_HOOK_OWNER_MODE     read | full-dm | full (default: read)
  --owner-tools a,b      ZALO_HOOK_OWNER_TOOLS    replace the owner's read-only tool list
  --extra-tools a,b      ZALO_HOOK_EXTRA_TOOLS    add tools to the owner's list
  --secret-paths p,q     ZALO_HOOK_SECRET_PATHS   extra paths (relative to ~ or absolute) to protect
  --allow-paths p,q      ZALO_HOOK_ALLOW_PATHS    extra readable paths inside protected ones
                                                  (always allowed: <profile>/cache/{documents,
                                                  images,audio,videos}, where inbound attachments land)
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
# Inbound attachments are cached here (gateway/platforms/base.py); owners must be able to read them.
ATTACHMENT_DIRS = ("cache/documents", "cache/images", "cache/audio", "cache/videos")
SECRET_NAMES = {".env", "auth.json", "config.json", "credentials", "credentials.json",
                "bridge.env", "id_rsa", "id_ed25519"}

OWNER_MODES = ("read", "full-dm", "full")

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


def read_dotenv(path: str) -> dict:
    """ZALO_HOOK_* entries of a KEY=VALUE file; missing or unreadable file -> {}."""
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return out
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if not key.startswith("ZALO_HOOK_"):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        out[key] = value
    return out


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # fail closed on bad configuration
        block(MSG_UNVERIFIED, f"bad-arguments {message}")


def configure(argv):
    global LOG
    p = _Parser(add_help=False)
    p.add_argument("--owner", action="append", default=[])
    p.add_argument("--profile-home")
    p.add_argument("--owner-mode")
    p.add_argument("--owner-tools")
    p.add_argument("--extra-tools", action="append", default=[])
    p.add_argument("--secret-paths", action="append", default=[])
    p.add_argument("--allow-paths", action="append", default=[])
    p.add_argument("--log")
    a = p.parse_args(argv)

    home = a.profile_home or os.environ.get("ZALO_HOOK_PROFILE_HOME") \
        or os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    home = os.path.realpath(os.path.expanduser(home))
    dotenv = read_dotenv(os.path.join(home, ".env"))

    def env(key):  # process env wins over the profile's .env
        return os.environ.get(key) or dotenv.get(key)

    LOG = os.path.expanduser(a.log or env("ZALO_HOOK_LOG")
                             or os.path.join(home, "logs", "zalo-tool-access.log"))

    mode = (a.owner_mode or env("ZALO_HOOK_OWNER_MODE") or "read").strip().lower()
    if mode not in OWNER_MODES:
        block(MSG_UNVERIFIED, f"bad-owner-mode {mode!r}")
    owners = set(split_list(",".join(a.owner)) or split_list(env("ZALO_HOOK_OWNERS")))
    tools = set(split_list(a.owner_tools or env("ZALO_HOOK_OWNER_TOOLS")) or DEFAULT_OWNER_TOOLS)
    tools |= set(split_list(",".join(a.extra_tools)) or split_list(env("ZALO_HOOK_EXTRA_TOOLS")))
    extra_secrets = split_list(",".join(a.secret_paths)) or split_list(env("ZALO_HOOK_SECRET_PATHS"))
    secret_prefixes = tuple(os.path.realpath(os.path.join(HOME, os.path.expanduser(s)))
                            for s in (*DEFAULT_SECRET_DIRS, *extra_secrets))
    extra_allowed = split_list(",".join(a.allow_paths)) or split_list(env("ZALO_HOOK_ALLOW_PATHS"))
    allowed_prefixes = tuple(os.path.realpath(os.path.join(home, d)) for d in ATTACHMENT_DIRS) + tuple(
        os.path.realpath(os.path.join(HOME, os.path.expanduser(s))) for s in extra_allowed)
    return {"state_db": os.path.join(home, "state.db"), "owners": owners, "tools": tools, "mode": mode,
            "secret_prefixes": secret_prefixes, "allowed_prefixes": allowed_prefixes}


def lookup(state_db: str, session_id: str):
    if not session_id:
        return None
    con = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=3)
    try:
        return con.execute("select source, user_id, chat_type from sessions where id=?",
                           (session_id,)).fetchone()
    finally:
        con.close()


def _under(real: str, prefix: str) -> bool:
    return real == prefix or real.startswith(prefix + os.sep)


def secret_path(path: str, cwd: str, prefixes, allowed=()) -> bool:
    p = os.path.expanduser(path or ".")
    if not os.path.isabs(p):
        p = os.path.join(cwd or HOME, p)
    real = os.path.realpath(p)
    base = next((a for a in allowed if _under(real, a)), None)
    if base is None and any(_under(real, s) for s in prefixes):
        return True
    rest = real[len(base):] if base else real  # names below an allowed dir are still checked
    return any(part in SECRET_NAMES or part.startswith(".env") for part in rest.split(os.sep))


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
        source, user_id, chat_type = (row[0] or "").lower(), str(row[1] or ""), (row[2] or "").lower()
    elif env_platform:
        # Chat type unknown here: treated as a group, so full-dm stays read-only.
        source, user_id, chat_type = env_platform, env_user, ""
    else:
        block(MSG_UNVERIFIED, f"unknown-session sid={sid} tool={tool}")

    if source != "zalo":
        return

    if user_id not in cfg["owners"]:
        block(MSG_DENY, f"non-owner user={user_id} sid={sid} tool={tool}")

    full = cfg["mode"] == "full" or (cfg["mode"] == "full-dm" and chat_type == "dm")
    if full:
        target = args.get("path") or args.get("file_path") or args.get("image_path")
        if isinstance(target, str) and secret_path(target, payload.get("cwd") or "", (), ()):
            block("Không được truy cập file thông tin đăng nhập/bí mật qua Zalo.",
                  f"owner-credential sid={sid} tool={tool} path={target}")
        log(f"ALLOW owner-full sid={sid} chat={chat_type} tool={tool}")
        return

    if tool not in cfg["tools"]:
        block(f"Trên Zalo chỉ được dùng công cụ đọc. `{tool}` hãy dùng qua CLI/TUI.",
              f"owner-nonread sid={sid} tool={tool}")

    if tool in PATH_TOOLS:
        target = args.get("path") or args.get("image_url") or args.get("image_path") or "."
        if isinstance(target, str) and not target.startswith(("http://", "https://", "data:")) \
                and secret_path(target, payload.get("cwd") or "", cfg["secret_prefixes"],
                                     cfg["allowed_prefixes"]):
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
