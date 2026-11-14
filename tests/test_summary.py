import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import summary  # noqa: E402
import watch  # noqa: E402

ITEM = {"title": "v2.1.325", "url": "https://x", "summary": "Adds a new flag. Fixes bugs."}
FALLBACK = ["Adds a new flag."]
KEY = {"GEMINI_API_KEY": "k"}


def gemini_says(text):
    return mock.patch.object(summary, "ask_gemini", return_value=text)


class T(unittest.TestCase):
    def setUp(self):
        summary._spent = 0.0

    def test_gemini_two_lines(self):
        with mock.patch.dict(os.environ, KEY), gemini_says("새 플래그가 추가됐어요.\n\n→ 설정이 쉬워져요.\n"):
            self.assertEqual(summary.summarize("s", ITEM), ["새 플래그가 추가됐어요.", "→ 설정이 쉬워져요."])

    def test_bad_format_falls_back(self):
        for text in ["한 줄만", "가\n나", "가\n→ 나\n다", "가" * 400 + "\n→ 나"]:
            with self.subTest(text=text[:10]), mock.patch.dict(os.environ, KEY), gemini_says(text):
                self.assertEqual(summary.summarize("s", ITEM), FALLBACK)

    def test_fallback_on_error_and_without_key(self):
        with mock.patch.dict(os.environ, KEY), \
             mock.patch.object(summary, "ask_gemini", side_effect=RuntimeError("429")):
            self.assertEqual(summary.summarize("s", ITEM), FALLBACK)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(summary.summarize("s", ITEM), FALLBACK)
            self.assertEqual(summary.summarize("s", {"title": "t"}), [])

    def test_persona_read_error_falls_back(self):
        with mock.patch.dict(os.environ, KEY), \
             mock.patch.object(summary.Path, "read_text", side_effect=UnicodeDecodeError("utf-8", b"", 0, 1, "x")):
            self.assertEqual(summary.summarize("s", ITEM), FALLBACK)

    def test_budget_skips_gemini(self):
        summary._spent = summary.BUDGET
        with mock.patch.dict(os.environ, KEY), mock.patch.object(summary, "ask_gemini") as ask:
            self.assertEqual(summary.summarize("s", ITEM), FALLBACK)
            ask.assert_not_called()

    def test_truncated_response_rejected(self):
        resp = {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": [{"text": "가\n→ 나"}]}}]}
        with mock.patch.object(summary.urllib.request, "urlopen",
                               return_value=io.BytesIO(json.dumps(resp).encode())):
            with self.assertRaises(ValueError):
                summary.ask_gemini("sys", "p", "k")

    def test_parts_joined_without_thought(self):
        resp = {"candidates": [{"finishReason": "STOP", "content": {"parts": [
            {"text": "생각", "thought": True}, {"text": "가\n"}, {"text": "→ 나"}]}}]}
        with mock.patch.object(summary.urllib.request, "urlopen",
                               return_value=io.BytesIO(json.dumps(resp).encode())):
            self.assertEqual(summary.ask_gemini("sys", "p", "k"), "가\n→ 나")

    def test_slow_response_cut_by_total_deadline(self):
        class Drip(io.BytesIO):  # 한 조각마다 시계가 10초씩 흐르는 느린 응답
            def read1(self, n=-1):
                clock[0] += 10
                return super().read(1)
        clock = [0.0]
        with mock.patch.object(summary.urllib.request, "urlopen", return_value=Drip(b'{"candidates": []}')), \
             mock.patch.object(summary.time, "monotonic", side_effect=lambda: clock[0]):
            with self.assertRaises(TimeoutError):
                summary.ask_gemini("sys", "p", "k", limit=15)

    def test_remaining_budget_limits_wait(self):
        summary._spent = summary.BUDGET - 5
        with mock.patch.dict(os.environ, KEY), mock.patch.object(summary, "ask_gemini", return_value="x") as ask:
            summary.summarize("s", ITEM)
        self.assertAlmostEqual(ask.call_args.args[3], 5)
        summary._spent = summary.BUDGET - 0.5
        with mock.patch.dict(os.environ, KEY), mock.patch.object(summary, "ask_gemini") as ask:
            summary.summarize("s", ITEM)
        ask.assert_not_called()

    def test_error_log_has_no_exception_text(self):
        with mock.patch.dict(os.environ, KEY), \
             mock.patch.object(summary, "ask_gemini", side_effect=ValueError("header value SECRET")), \
             mock.patch("builtins.print") as p:
            summary.summarize("s", ITEM)
        self.assertNotIn("SECRET", str(p.call_args_list))

    def test_first_sentence_limit(self):
        self.assertTrue(summary.first_sentence("가" * 500).endswith("…"))

    def test_feed_summary_html_stripped(self):
        rss = "<rss><channel><item><title>A</title><link>l</link><description>&lt;p&gt;Hello &amp;amp; bye&lt;/p&gt;</description></item></channel></rss>"
        self.assertEqual(watch.parse_feed(rss)[0]["summary"], "Hello & bye")

    def test_message_has_summary_escaped_and_bounded(self):
        msg = watch.format_instant("s", ITEM, ["<b>요약</b>", "→ 의미"])
        self.assertIn("&lt;b&gt;요약&lt;/b&gt;\n→ 의미\n\n<a href", msg)
        self.assertNotIn("\n\n\n", watch.format_instant("s", ITEM, []))
        long = watch.format_instant("s", {"title": "가" * 5000, "url": "https://x"}, ["가" * 300, "→ " + "나" * 298])
        self.assertLess(len(long), 4096)


if __name__ == "__main__":
    unittest.main()
