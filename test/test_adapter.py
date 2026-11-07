"""Unit tests for hermes-plugin/adapter.py helpers.

The adapter imports Hermes gateway modules at import time; they are stubbed
here so the tests run without a Hermes checkout:  python -m unittest discover -s test
"""

import asyncio
import json
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path


def _load_adapter():
    gateway = types.ModuleType("gateway")
    platforms = types.ModuleType("gateway.platforms")
    base = types.ModuleType("gateway.platforms.base")
    config = types.ModuleType("gateway.config")

    class BasePlatformAdapter:
        def __init__(self, config=None, platform=None):
            self.config = config
            self.platform = platform
            self._message_handler = None

    for name in ("SendResult", "MessageEvent", "MessageType"):
        setattr(base, name, type(name, (), {}))
    base.BasePlatformAdapter = BasePlatformAdapter
    for name in ("cache_image_from_bytes", "cache_audio_from_bytes", "cache_document_from_bytes"):
        setattr(base, name, lambda *a, **k: None)
    config.Platform = lambda value: value
    sys.modules.update({
        "gateway": gateway,
        "gateway.platforms": platforms,
        "gateway.platforms.base": base,
        "gateway.config": config,
    })
    path = Path(__file__).resolve().parent.parent / "hermes-plugin" / "adapter.py"
    spec = importlib.util.spec_from_file_location("zalo_adapter_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


adapter = _load_adapter()


class Cfg:
    extra = {}


class StripLeadingNameTest(unittest.TestCase):
    def setUp(self):
        self.a = adapter.ZaloAdapter(Cfg())

    def test_generic_words_do_not_address_the_bot_by_default(self):
        self.a._own_name = "Lily"
        self.assertIsNone(self.a._strip_leading_name("Bot của nhóm mình chạy ổn ghê"))
        self.assertIsNone(self.a._strip_leading_name("hermes agent hay quá"))

    def test_trigger_words_need_a_word_boundary(self):
        self.a.group_triggers = ["bot", "hermes"]
        self.assertEqual(self.a._strip_leading_name("bot ơi hello"), "ơi hello")
        self.assertEqual(self.a._strip_leading_name("@hermes, tóm tắt giúp"), "tóm tắt giúp")
        self.assertIsNone(self.a._strip_leading_name("both of us"))
        self.assertIsNone(self.a._strip_leading_name("bottom line"))
        self.assertIsNone(self.a._strip_leading_name("hello bot"))

    def test_own_display_name(self):
        self.a._own_name = "Lily"
        self.assertEqual(self.a._strip_leading_name("Lily: mấy giờ rồi"), "mấy giờ rồi")
        self.assertEqual(self.a._strip_leading_name("@lily mấy giờ rồi"), "mấy giờ rồi")
        self.assertIsNone(self.a._strip_leading_name("Lilyanne ơi"))

    def test_bare_name_returns_text(self):
        self.a._own_name = "Lily"
        self.assertEqual(self.a._strip_leading_name("Lily"), "Lily")


class HomeChannelTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(adapter._parse_home_channel("group:123"), ("123", "group"))
        self.assertEqual(adapter._parse_home_channel("456"), ("456", "user"))
        self.assertEqual(adapter._parse_home_channel(""), ("", "user"))

    def test_seeds_thread_type(self):
        old = os.environ.get("ZALO_HOME_CHANNEL")
        os.environ["ZALO_HOME_CHANNEL"] = "group:999"
        try:
            a = adapter.ZaloAdapter(Cfg())
            self.assertEqual(a._thread_type_from_chat_id("999", None), "group")
            self.assertEqual(a._thread_type_from_chat_id("111", None), "user")
        finally:
            if old is None:
                os.environ.pop("ZALO_HOME_CHANNEL", None)
            else:
                os.environ["ZALO_HOME_CHANNEL"] = old


class ThreadTypeTest(unittest.TestCase):
    """Outbound sends carry no thread type; group ids must still route as groups."""

    def setUp(self):
        self.a = adapter.ZaloAdapter(Cfg())
        self.calls = []

        async def fake_get(path, params=None):
            self.calls.append(path)
            return {"success": True, "groups": {"version": "1", "gridVerMap": {"777": "1"}}}

        self.a._get = fake_get

    def test_unknown_id_refreshes_group_list(self):
        self.assertEqual(asyncio.run(self.a._resolve_thread_type("777")), "group")
        self.assertEqual(self.calls, ["/groups"])

    def test_refresh_is_throttled(self):
        asyncio.run(self.a._resolve_thread_type("111"))
        self.assertEqual(asyncio.run(self.a._resolve_thread_type("222")), "user")
        self.assertEqual(self.calls, ["/groups"])

    def test_remembered_and_metadata_win_without_a_fetch(self):
        self.a._thread_types["555"] = "user"
        self.assertEqual(asyncio.run(self.a._resolve_thread_type("555")), "user")
        self.assertEqual(asyncio.run(self.a._resolve_thread_type("9", {"thread_type": "group"})), "group")
        self.assertEqual(self.calls, [])

    def test_group_event_marks_the_id_as_group(self):
        self.a._note_group_event({"type": "join", "data": {"groupId": "888", "groupName": "Bot Group"}})
        self.assertEqual(self.a._thread_type_from_chat_id("888", None), "group")
        self.assertEqual(asyncio.run(self.a._group_name("888")), "Bot Group")


class ReplyFieldsTest(unittest.TestCase):
    def setUp(self):
        self.a = adapter.ZaloAdapter(Cfg())
        self.a._own_id = "42"

    def test_quote_of_bot_message(self):
        f = self.a._reply_fields({"quoted": {"msgId": "9", "senderId": "42", "senderName": "Lily", "text": "2 + 3 = 5"}})
        self.assertEqual(f["reply_to_message_id"], "9")
        self.assertEqual(f["reply_to_text"], "2 + 3 = 5")
        self.assertEqual(f["reply_to_author_name"], "Lily")
        self.assertTrue(f["reply_to_is_own_message"])

    def test_quote_of_someone_else(self):
        f = self.a._reply_fields({"quoted": {"msgId": "9", "senderId": "7", "text": "hi"}})
        self.assertFalse(f["reply_to_is_own_message"])

    def test_no_quote(self):
        self.assertEqual(self.a._reply_fields({"quoted": None}), {})


class QuotedReplyTest(unittest.TestCase):
    """A reply to an inbound group message quotes it, once per turn."""

    QUOTE = {"content": "@Lily 2+3?", "msgType": "webchat", "uidFrom": "7", "msgId": "100", "cliMsgId": "5", "ts": "1", "ttl": 0}

    def setUp(self):
        self.a = adapter.ZaloAdapter(Cfg())
        self.a._thread_types.update({"g1": "group", "u1": "user"})
        self.a.truncate_message = lambda content, max_length: [content]
        self._send_result = adapter.SendResult
        adapter.SendResult = lambda **kw: types.SimpleNamespace(**kw)
        self.posts = []
        self.fail_quoted = False

        async def fake_post(path, body):
            self.posts.append(body)
            if self.fail_quoted and "quote" in body:
                return {"error": "This kind of `webchat` quote type is not available"}
            return {"success": True, "result": {"message": {"msgId": "m%d" % len(self.posts)}}}

        self.a._post = fake_post

        async def no_sleep(_s):
            return None

        self._sleep = adapter.asyncio.sleep
        adapter.asyncio.sleep = no_sleep

    def tearDown(self):
        adapter.asyncio.sleep = self._sleep
        adapter.SendResult = self._send_result

    def _inbound(self, thread_id):
        self.a._remember_quote({"messageId": "100", "threadId": thread_id, "quote": dict(self.QUOTE)})

    def test_group_reply_quotes_the_question_once(self):
        self._inbound("g1")
        asyncio.run(self.a.send("g1", "5", reply_to="100"))
        asyncio.run(self.a.send("g1", "thêm nữa", reply_to="100"))
        self.assertEqual(self.posts[0]["quote"]["msgId"], "100")
        self.assertNotIn("quote", self.posts[1])

    def test_dm_reply_is_not_quoted_by_default(self):
        self._inbound("u1")
        asyncio.run(self.a.send("u1", "5", reply_to="100"))
        self.assertNotIn("quote", self.posts[0])

    def test_mode_all_quotes_dms(self):
        self.a.reply_quote = "all"
        self._inbound("u1")
        asyncio.run(self.a.send("u1", "5", reply_to="100"))
        self.assertIn("quote", self.posts[0])

    def test_refused_quote_falls_back_to_plain_send(self):
        self.fail_quoted = True
        self._inbound("g1")
        res = asyncio.run(self.a.send("g1", "5", reply_to="100"))
        self.assertTrue(res.success)
        self.assertEqual(len(self.posts), 2)
        self.assertNotIn("quote", self.posts[1])

    def test_unknown_reply_to_sends_plain(self):
        asyncio.run(self.a.send("g1", "5", reply_to="999"))
        self.assertNotIn("quote", self.posts[0])


class HeldMediaTest(unittest.TestCase):
    """A caption-less file/image waits for the sender's next text message."""

    FILE = {"kind": "file", "url": "http://f/test.txt", "fileName": "test.txt", "mime": "application/octet-stream"}
    IMAGE = {"kind": "image", "url": "http://f/a.jpg", "mime": "image/jpeg"}

    def setUp(self):
        self._event, self._type = adapter.MessageEvent, adapter.MessageType

        class Ev:
            def __init__(self, **kw):
                self.__dict__.update(kw)

        adapter.MessageEvent = Ev
        adapter.MessageType = types.SimpleNamespace(TEXT="text", DOCUMENT="document", PHOTO="photo")
        self.a = adapter.ZaloAdapter(Cfg())
        self.a.media_wait = 300
        self.a._message_handler = object()
        self.events, self.downloads = [], []
        self.a.build_source = lambda **kw: kw

        async def handle(ev):
            self.events.append(ev)

        async def download(media):
            self.downloads.append(media["url"])
            kind = adapter.MessageType.PHOTO if media["kind"] == "image" else adapter.MessageType.DOCUMENT
            return "/cache/" + media["url"].rsplit("/", 1)[-1], kind

        self.a.handle_message = handle
        self.a._download_media = download

    def tearDown(self):
        adapter.MessageEvent, adapter.MessageType = self._event, self._type

    def msg(self, text, media=None, sender="u1", thread="u1", ttype="user"):
        m = {"threadId": thread, "threadType": ttype, "senderId": sender, "text": text, "messageId": "1"}
        if media:
            m["media"] = media
        asyncio.run(self.a._on_inbound_message(m))

    def test_file_alone_starts_no_turn_and_joins_next_text(self):
        self.msg("[file: test.txt]", self.FILE)
        self.assertEqual(self.events, [])
        self.assertEqual(self.downloads, [])
        self.msg("Thử đọc file trên")
        ev = self.events[0]
        self.assertEqual(ev.text, "Thử đọc file trên")
        self.assertEqual(ev.media_urls, ["/cache/test.txt"])
        self.assertEqual(ev.message_type, "document")
        self.msg("tin tiếp theo")
        self.assertEqual(self.events[1].media_urls, [])

    def test_captioned_image_is_not_held(self):
        self.msg("ảnh này là gì?", self.IMAGE)
        self.assertEqual(self.events[0].media_urls, ["/cache/a.jpg"])

    def test_held_media_is_per_sender_and_expires(self):
        self.msg("", self.IMAGE, sender="u2", thread="g1", ttype="group")
        self.msg("hello", sender="u1", thread="u1")
        self.assertEqual(self.events[0].media_urls, [])
        key = ("g1", "u2")
        self.a._held_media[key] = [(adapter.time.monotonic() - 301, self.IMAGE)]
        self.assertEqual(self.a._take_held_media("g1", "u2"), [])

    def test_owner_session_gets_owner_topic(self):
        self.a._owner_ids = {"u1"}
        self.msg("hi", sender="u1")
        self.msg("hi", sender="u2", thread="u2")
        self.assertEqual(self.events[0].source["chat_topic"], adapter.ZaloAdapter._OWNER_TOPIC)
        self.assertIsNone(self.events[1].source["chat_topic"])

    def test_owner_ids_fall_back_to_hook_owners(self):
        old = {k: os.environ.pop(k, None) for k in ("ZALO_OWNER_IDS", "ZALO_HOOK_OWNERS")}
        try:
            os.environ["ZALO_HOOK_OWNERS"] = "7, 8"
            self.assertEqual(adapter.ZaloAdapter(Cfg())._owner_ids, {"7", "8"})
            os.environ["ZALO_OWNER_IDS"] = "9"
            self.assertEqual(adapter.ZaloAdapter(Cfg())._owner_ids, {"9"})
            os.environ.pop("ZALO_OWNER_IDS"); os.environ.pop("ZALO_HOOK_OWNERS")
            admin_cfg = type("C", (), {"extra": {"allow_admin_from": ["550", 551]}})()
            self.assertEqual(adapter.ZaloAdapter(admin_cfg)._owner_ids, {"550", "551"})
        finally:
            for k, v in old.items():
                os.environ.pop(k, None)
                if v is not None:
                    os.environ[k] = v

    def test_wait_zero_replies_to_attachment_alone(self):
        self.a.media_wait = 0
        self.msg("[file: test.txt]", self.FILE)
        self.assertEqual(self.events[0].media_urls, ["/cache/test.txt"])


class TargetTest(unittest.TestCase):
    """Cron --deliver zalo:group:<id> must reach Zalo as the bare id."""

    def test_parse_target_ref(self):
        self.assertEqual(adapter._parse_target_ref("group:2901896628710819982"), ("2901896628710819982", None))
        self.assertEqual(adapter._parse_target_ref("user:123"), ("123", None))
        self.assertEqual(adapter._parse_target_ref("123"), ("123", None))
        self.assertIsNone(adapter._parse_target_ref("Bot Group"))

    def test_prefixed_chat_id_is_stripped_and_typed(self):
        a = adapter.ZaloAdapter(Cfg())

        async def no_get(path, params=None):
            raise AssertionError("prefix should make a lookup unnecessary")

        a._get = no_get
        self.assertEqual(asyncio.run(a._target("group:2901896628710819982")), ("2901896628710819982", "group"))
        self.assertEqual(asyncio.run(a._target("user:55")), ("55", "user"))


class SendImageTest(unittest.TestCase):
    def setUp(self):
        self.a = adapter.ZaloAdapter(Cfg())
        self.a._thread_types["g1"] = "group"
        self._send_result = adapter.SendResult
        adapter.SendResult = lambda **kw: types.SimpleNamespace(**kw)
        self.posts = []

        async def fake_post(path, body):
            self.posts.append((path, body))
            return {"success": True}

        self.a._post = fake_post

    def tearDown(self):
        adapter.SendResult = self._send_result

    def test_file_url_is_sent_as_local_path(self):
        res = asyncio.run(self.a.send_image("g1", "file:///tmp/a%20b.png", caption="hi"))
        self.assertTrue(res.success)
        self.assertEqual(self.posts, [("/send-attachment", {
            "threadId": "g1", "threadType": "group", "path": "/tmp/a b.png", "caption": "hi"})])

    def test_remote_url_is_downloaded_first(self):
        async def fake_download(url):
            return "/cache/img.png"

        self.a._download_to_cache = fake_download
        asyncio.run(self.a.send_image("g1", "https://x/y.png"))
        self.assertEqual(self.posts[0][1]["path"], "/cache/img.png")


class EmptyImageTagTest(unittest.TestCase):
    def test_leftover_tag_is_removed(self):
        self.assertEqual(adapter._strip_empty_image_tags("![Ảnh gradient]()\n\nLily gửi ảnh rồi nhé!"),
                         "Lily gửi ảnh rồi nhé!")

    def test_real_images_and_text_untouched(self):
        text = "xem ![a](https://x/y.png) nhé"
        self.assertEqual(adapter._strip_empty_image_tags(text), text)


class GroupToolsTest(unittest.TestCase):
    CONTACTS = {"success": True, "groups": [
        {"id": "111", "name": "Bot Group", "members": 3},
        {"id": "222", "name": "Cộng Đồng HubPlus AI", "members": 13},
        {"id": "333", "name": "Cộng đồng AI Native Lab 01", "members": 999}]}

    def setUp(self):
        self.calls = []

        def fake_get(path, params=None):
            self.calls.append((path, params))
            if path == "/contacts":
                return self.CONTACTS
            if path == "/group-messages":
                return {"success": True, "loggedSince": None, "messages": [
                    {"t": 1793862124026, "u": "7", "n": "Hubplus", "x": "chào cả nhóm", "s": 0},
                    {"t": 1793862130000, "u": "42", "n": "Lily", "x": "", "k": "chat.photo", "s": 1}]}
            if path == "/group-stats":
                return {"success": True, "groups": [
                    {"id": "111", "name": "Bot Group", "members": 3, "messages": 2, "senders": 1,
                     "topSenders": [{"id": "7", "name": "Hubplus", "count": 2}], "lastMessageAt": 1793862124026},
                    {"id": "222", "name": "Cộng Đồng HubPlus AI", "members": 13, "messages": 5, "senders": 2,
                     "topSenders": [], "lastMessageAt": None}]}
            return {"error": "unexpected"}

        self._get = adapter._bridge_get
        adapter._bridge_get = fake_get

    def tearDown(self):
        adapter._bridge_get = self._get

    def test_stats_sorted_by_activity(self):
        out = json.loads(adapter._tool_group_stats({"hours": 24}))
        self.assertEqual([g["name"] for g in out["groups"]], ["Cộng Đồng HubPlus AI", "Bot Group"])
        self.assertEqual(out["groups"][1]["top_senders"], ["Hubplus (2)"])

    def test_messages_by_accentless_name(self):
        out = json.loads(adapter._tool_group_messages({"group": "cong dong hubplus"}))
        self.assertTrue(out["success"])
        self.assertEqual(out["group_id"], "222")
        self.assertIn("Hubplus: chào cả nhóm", out["messages"])
        self.assertIn("Lily (bot): [chat.photo]", out["messages"])

    def test_ambiguous_name_lists_matches(self):
        out = json.loads(adapter._tool_group_messages({"group": "cộng đồng"}))
        self.assertFalse(out["success"])
        self.assertEqual({m["id"] for m in out["matches"]}, {"222", "333"})

    def test_defaults_to_current_group(self):
        env = {"HERMES_SESSION_PLATFORM": "zalo", "HERMES_SESSION_CHAT_TYPE": "group",
               "HERMES_SESSION_CHAT_ID": "111"}
        old = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            out = json.loads(adapter._tool_group_messages({}))
        finally:
            for k, v in old.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        self.assertEqual(out["group_id"], "111")
        self.assertEqual(self.calls[-1], ("/group-messages", {"groupId": "111", "hours": 24, "limit": 300}))

    def test_outside_a_group_needs_a_name(self):
        self.assertFalse(json.loads(adapter._tool_group_messages({}))["success"])


class ManifestTest(unittest.TestCase):
    """plugin.yaml must declare what register() registers (the installer reads it)."""

    def test_provides_match_register(self):
        registered = []

        class Ctx:
            def register_tool(self, **kw):
                registered.append((kw["name"], kw["toolset"]))

            def register_platform(self, **kw):
                pass

        adapter.register(Ctx())
        text = (Path(adapter.__file__).parent / "plugin.yaml").read_text(encoding="utf-8")

        def listed(key):
            block = text.split(key + ":\n", 1)[1]
            out = []
            for line in block.splitlines():
                if not line.strip().startswith("- "):
                    break
                out.append(line.strip()[2:].strip())
            return out

        self.assertEqual(sorted(listed("provides_tools")), sorted(n for n, _ in registered))
        self.assertEqual(sorted(listed("provides_toolsets")), sorted({t for _, t in registered}))


class BridgeEnvTest(unittest.TestCase):
    def test_merge_keeps_other_keys_and_removes_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "bridge.env")
            with open(path, "w", encoding="utf-8") as f:
                f.write("# mine\nZALO_PLUGIN_PORT=9000\nZALO_ALLOWED_ACTIONS=old\n")
            old = os.environ.get("ZALO_BRIDGE_ENV")
            os.environ["ZALO_BRIDGE_ENV"] = path
            try:
                adapter._write_bridge_env({
                    "ZALO_ALLOWED_ACTIONS": "",
                    "ZALO_ALLOWED_ACTION_GROUPS": "read,send",
                })
            finally:
                if old is None:
                    os.environ.pop("ZALO_BRIDGE_ENV", None)
                else:
                    os.environ["ZALO_BRIDGE_ENV"] = old
            text = Path(path).read_text(encoding="utf-8")
            self.assertIn("ZALO_PLUGIN_PORT=9000", text)
            self.assertIn("ZALO_ALLOWED_ACTION_GROUPS=read,send", text)
            self.assertNotIn("ZALO_ALLOWED_ACTIONS=", text)
            if os.name == "posix":
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)


class SensitiveActionsTest(unittest.TestCase):
    def test_sensitive_actions_are_known(self):
        for name in adapter._SENSITIVE_ACTIONS:
            self.assertIn(name, adapter._ACTION_GROUP)


class BridgeCliTest(unittest.TestCase):
    """bridge_cli.json (written by setup next to adapter.py) locates the checkout CLI."""

    def _with_record(self, record):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        fake = Path(tmp.name) / "adapter.py"
        if record is not None:
            (Path(tmp.name) / "bridge_cli.json").write_text(
                record if isinstance(record, str) else json.dumps(record), encoding="utf-8")
        old = adapter.__file__
        adapter.__file__ = str(fake)
        self.addCleanup(setattr, adapter, "__file__", old)
        return Path(tmp.name)

    def test_reads_node_and_cli(self):
        d = self._with_record(None)
        cli = d / "cli.mjs"
        cli.write_text("", encoding="utf-8")
        (d / "bridge_cli.json").write_text(json.dumps({"node": "/usr/bin/node", "cli": str(cli)}), encoding="utf-8")
        self.assertEqual(adapter._bridge_cli_cmd(), ["/usr/bin/node", str(cli)])
        self.assertIn(str(cli), adapter._bridge_cli_hint())

    def test_missing_or_broken_record(self):
        for record in (None, "not json", {"node": "node"}, {"node": "node", "cli": "/nope/cli.mjs"}):
            with self.subTest(record=record):
                self._with_record(record)
                self.assertIsNone(adapter._bridge_cli_cmd())
                self.assertEqual(adapter._bridge_cli_hint(), "node <bridge checkout>/bin/cli.mjs")
                self.assertFalse(adapter._run_bridge_cli("status"))


class ScopedEnvTest(unittest.TestCase):
    """One gateway serves every profile: settings come from the active profile's
    secret scope (get_scoped_secret), not the default profile's os.environ."""

    def setUp(self):
        self.shared = types.ModuleType("gateway.platforms._shared")
        self.scope = {}
        self.shared.get_scoped_secret = lambda name, default=None: self.scope.get(name, default)
        sys.modules["gateway.platforms._shared"] = self.shared
        self._saved = {k: os.environ.pop(k, None) for k in ("ZALO_PLUGIN_URL", "ZALO_ALLOWED_USERS")}
        os.environ["ZALO_PLUGIN_URL"] = "http://default:1"
        os.environ["ZALO_ALLOWED_USERS"] = "999"

    def tearDown(self):
        sys.modules.pop("gateway.platforms._shared", None)
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_profile_scope_wins_over_process_env(self):
        self.scope.update({"ZALO_PLUGIN_URL": "http://lily:2/", "ZALO_ALLOWED_USERS": "1,2"})
        a = adapter.ZaloAdapter(Cfg())
        self.assertEqual(a.bridge_url, "http://lily:2")
        self.assertEqual(a.allowed_users, ["1", "2"])

    def test_scoped_miss_does_not_borrow_default_profile_env(self):
        a = adapter.ZaloAdapter(Cfg())
        self.assertEqual(a.allowed_users, [])
        self.assertFalse(adapter.validate_config(Cfg()))

    def test_without_scoped_reader_falls_back_to_os_environ(self):
        sys.modules.pop("gateway.platforms._shared", None)
        self.assertEqual(adapter._env("ZALO_PLUGIN_URL"), "http://default:1")

    def test_check_fn_is_a_dependency_probe_only(self):
        # The shared gateway may call check_fn outside the profile scope.
        try:
            import aiohttp  # noqa: F401
        except ImportError:
            self.skipTest("aiohttp not installed")
        self.assertTrue(adapter.check_requirements())


if __name__ == "__main__":
    unittest.main()
