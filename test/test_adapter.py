"""Unit tests for hermes-plugin/adapter.py helpers.

The adapter imports Hermes gateway modules at import time; they are stubbed
here so the tests run without a Hermes checkout:  python -m unittest discover -s test
"""

import asyncio
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


if __name__ == "__main__":
    unittest.main()
