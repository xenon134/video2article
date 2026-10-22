#!/usr/bin/env python3
"""Unit tests for the local Video Reader server.

Run with:

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import server


class VideoIdTests(unittest.TestCase):
    def test_accepts_raw_id(self):
        self.assertEqual(server.extract_video_id("dQw4w9WgXcQ"), "dQw4w9WgXcQ")

    def test_accepts_watch_url(self):
        self.assertEqual(
            server.extract_video_id(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42"
            ),
            "dQw4w9WgXcQ",
        )

    def test_accepts_short_urls_and_paths(self):
        cases = [
            "https://youtu.be/dQw4w9WgXcQ?si=abc",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "youtu.be/dQw4w9WgXcQ",
            "  dQw4w9WgXcQ  ",
        ]
        for value in cases:
            with self.subTest(value=value):
                self.assertEqual(server.extract_video_id(value), "dQw4w9WgXcQ")

    def test_rejects_non_youtube_urls(self):
        for value in [
            "",
            "not a url",
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=too-short",
        ]:
            with self.subTest(value=value):
                self.assertIsNone(server.extract_video_id(value))


class SubtitleFormatTests(unittest.TestCase):
    def test_vtt_converts_to_srt(self):
        vtt = """WEBVTT

00:00:01.000 --> 00:00:03.500 align:start position:0%
Hello <i>world</i>.

00:03.500 --> 00:00:05.000
Second line
"""
        srt = server.vtt_to_srt(vtt)
        self.assertIsNotNone(srt)
        assert srt is not None
        self.assertIn("00:00:01,000 --> 00:00:03,500", srt)
        self.assertIn("Hello world.", srt)
        self.assertIn("Second line", srt)

    def test_json3_converts_to_srt(self):
        payload = {
            "events": [
                {
                    "tStartMs": 1000,
                    "dDurationMs": 2000,
                    "segs": [{"utf8": "Hello "}, {"utf8": "there."}],
                },
                {
                    "tStartMs": 3000,
                    "dDurationMs": 1500,
                    "segs": [{"utf8": "Second cue."}],
                },
            ]
        }
        srt = server.json3_to_srt(json.dumps(payload))
        self.assertIsNotNone(srt)
        assert srt is not None
        self.assertIn("00:00:01,000 --> 00:00:03,000", srt)
        self.assertIn("Hello there.", srt)
        self.assertIn("00:00:03,000 --> 00:00:04,500", srt)

    def test_normalize_srt_rejects_non_srt(self):
        self.assertIsNone(server.normalize_srt("just some text"))
        self.assertIsNone(server.normalize_srt(""))

    def test_subtitle_candidates_prefers_manual_requested_track(self):
        info = {
            "language": "en",
            "subtitles": {"en": [{"ext": "srt", "url": "manual"}]},
            "automatic_captions": {
                "en": [{"ext": "srt", "url": "auto-en"}],
                "en-orig": [{"ext": "srt", "url": "auto-orig"}],
                "fr": [{"ext": "srt", "url": "auto-fr"}],
            },
        }
        candidates = server.subtitle_candidates(info, "en")
        self.assertEqual(candidates[0][0], "manual")
        self.assertEqual(candidates[0][1], "en")
        self.assertEqual(candidates[1][0], "auto")
        self.assertEqual(candidates[1][1], "en")


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache_dir = Path(self.tmp.name)
        self.patch = mock.patch.object(server, "CACHE_DIR", self.cache_dir)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_write_then_read_cache(self):
        srt = "1\n00:00:01,000 --> 00:00:02,000\nHello.\n"
        data = {
            "version": server.CACHE_VERSION,
            "video_id": "dQw4w9WgXcQ",
            "title": "A title",
            "duration": 2,
            "requested_language": "en",
            "language": "en",
            "auto": False,
            "source_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "fetched_at": "2026-01-01T00:00:00Z",
        }
        server._write_cache("dQw4w9WgXcQ", "en", data, srt)

        cached = server._read_cache("dQw4w9WgXcQ", "en", refresh=False)
        self.assertIsNotNone(cached)
        assert cached is not None
        self.assertTrue(cached["cached"])
        self.assertEqual(cached["title"], "A title")
        self.assertEqual(cached["subtitle"], srt)
        self.assertEqual(cached["subtitle_file"], "dQw4w9WgXcQ.en.srt")

        json_path, srt_path = server._cache_paths("dQw4w9WgXcQ", "en")
        self.assertTrue(json_path.is_file())
        self.assertTrue(srt_path.is_file())

        self.assertIsNone(server._read_cache("dQw4w9WgXcQ", "en", refresh=True))

    def test_missing_subtitle_file_invalidates_cache(self):
        srt = "1\n00:00:01,000 --> 00:00:02,000\nHello.\n"
        data = {
            "version": server.CACHE_VERSION,
            "video_id": "dQw4w9WgXcQ",
            "title": "A title",
            "language": "en",
        }
        server._write_cache("dQw4w9WgXcQ", "en", data, srt)
        _, srt_path = server._cache_paths("dQw4w9WgXcQ", "en")
        srt_path.unlink()

        self.assertIsNone(server._read_cache("dQw4w9WgXcQ", "en", refresh=False))

    def test_no_subtitle_result_is_cached(self):
        data = {
            "version": server.CACHE_VERSION,
            "video_id": "dQw4w9WgXcQ",
            "title": "Title only",
            "language": None,
        }
        server._write_cache("dQw4w9WgXcQ", "en", data, None)
        cached = server._read_cache("dQw4w9WgXcQ", "en", refresh=False)
        self.assertIsNotNone(cached)
        assert cached is not None
        self.assertIsNone(cached["subtitle"])
        self.assertIsNone(cached["subtitle_file"])

    def test_corrupt_json_invalidates_cache(self):
        json_path, _ = server._cache_paths("dQw4w9WgXcQ", "en")
        json_path.write_text("{not json", encoding="utf-8")
        self.assertIsNone(server._read_cache("dQw4w9WgXcQ", "en", refresh=False))


class ErrorMessageTests(unittest.TestCase):
    def test_strips_ansi_and_error_prefix(self):
        message = server.friendly_error(Exception("\x1b[31mERROR: something broke\x1b[0m"))
        self.assertEqual(message, "something broke")

    def test_maps_unavailable_video(self):
        self.assertIn(
            "unavailable",
            server.friendly_error(Exception("ERROR: Video unavailable")).lower(),
        )


if __name__ == "__main__":
    unittest.main()
