"""Unit tests for hermes-plugin/adapter.py helpers.

The adapter imports Hermes gateway modules at import time; they are stubbed
here so the tests run without a Hermes checkout:  python -m unittest discover -s test
"""

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

    def test_trigger_words_need_a_word_boundary(self):
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
        self.assertEqual(self.a._strip_leading_name("bot"), "bot")


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
