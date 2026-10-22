#!/usr/bin/env python3
"""Local server for Video Reader.

Serves the static app, and exposes:

    GET /api/youtube?url=<YouTube URL or ID>&lang=en&refresh=0

That endpoint uses yt-dlp to resolve the video title and subtitle track, then
caches the chosen subtitles as an .srt file in ./cache/.  Repeating the request
reads the cache instead of hitting YouTube again.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import json
import os
import re
import sys
import threading
import urllib.parse
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    import yt_dlp
except ImportError:  # pragma: no cover - startup guard
    print("yt-dlp is required. Install it with: pip install yt-dlp", file=sys.stderr)
    raise

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "cache"
CACHE_VERSION = 1
FORMAT_CACHE_VERSION = 1

# yt-dlp is network-bound; serializing fetches keeps duplicate requests from
# hammering YouTube and racing on the same cache files.
YDL_LOCK = threading.Lock()
FORMAT_LOCK = threading.Lock()
FORMATTER_LOAD_LOCK = threading.Lock()
_FORMATTER = None
_FORMATTER_LOADED = False
_FORMATTER_LOAD_ERROR: str | None = None

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
SAFE_LANG_RE = re.compile(r"[^A-Za-z0-9_-]+")
SRT_TIME_RE = re.compile(
    r"\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}"
)
VTT_TS_RE = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def extract_video_id(raw: str) -> str | None:
    """Accept a YouTube URL, youtu.be link, embed/shorts link, or raw ID."""
    value = (raw or "").strip()
    if not value:
        return None

    if VIDEO_ID_RE.fullmatch(value):
        return value

    candidate = value
    if candidate.startswith("//"):
        candidate = "https:" + candidate
    elif "://" not in candidate:
        if candidate.startswith(("youtu.be/", "www.youtube.com/", "youtube.com/",
                                 "m.youtube.com/", "music.youtube.com/")):
            candidate = "https://" + candidate
        else:
            return None

    try:
        parsed = urllib.parse.urlparse(candidate)
    except ValueError:
        return None

    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]

    if host == "youtu.be":
        vid = parsed.path.strip("/").split("/")[0]
        return vid if VIDEO_ID_RE.fullmatch(vid) else None

    if host not in {
        "youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtube-nocookie.com",
    }:
        return None

    qs = urllib.parse.parse_qs(parsed.query)
    if qs.get("v"):
        vid = qs["v"][0]
        if VIDEO_ID_RE.fullmatch(vid):
            return vid

    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) >= 2 and parts[0] in {"shorts", "embed", "live", "v"}:
        vid = parts[1]
        if VIDEO_ID_RE.fullmatch(vid):
            return vid

    return None


def safe_lang(lang: str) -> str:
    cleaned = SAFE_LANG_RE.sub("_", (lang or "en").strip())[:32]
    return cleaned or "en"


def _ordered_keys(keys: list[str], lang: str, original: str = "") -> list[str]:
    """Order subtitle language keys by preference for ``lang``."""
    keys = list(keys)
    out: list[str] = []

    def add(items):
        for item in items:
            if item not in out:
                out.append(item)

    def family(target: str):
        target = (target or "").lower()
        if not target:
            return
        add([k for k in keys if k.lower() == target])
        add([k for k in keys
             if (k.lower().startswith(target + "-") or k.lower().startswith(target + "_"))
             and not k.lower().endswith("-orig")])
        add([k for k in keys
             if (k.lower().startswith(target + "-") or k.lower().startswith(target + "_"))
             and k.lower().endswith("-orig")])

    family(lang)
    family(original)
    add(keys)
    return out


def subtitle_candidates(info: dict[str, Any], lang: str) -> list[tuple[str, str, list[dict[str, Any]]]]:
    """Return manual/auto subtitle tracks in preference order."""
    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    original = (info.get("language") or "").strip()
    requested = (lang or "en").strip()

    def first_key(tracks: dict[str, Any], target: str) -> str | None:
        for key in _ordered_keys(list(tracks.keys()), target, original):
            if key.lower().startswith(target.lower()):
                return key
        return None

    candidates: list[tuple[str, str, list[dict[str, Any]]]] = []
    seen: set[tuple[str, str]] = set()

    def push(kind: str, tracks: dict[str, Any], key: str | None):
        if not key or key not in tracks:
            return
        marker = (kind, key)
        if marker in seen:
            return
        seen.add(marker)
        candidates.append((kind, key, tracks[key] or []))

    manual_req = first_key(manual, requested)
    auto_req = first_key(auto, requested)
    manual_orig = first_key(manual, original) if original else None
    auto_orig = first_key(auto, original) if original else None

    push("manual", manual, manual_req)
    push("auto", auto, auto_req)
    push("manual", manual, manual_orig)
    push("auto", auto, auto_orig)

    # Last resort: any remaining manual track, then any remaining auto track.
    for kind, tracks in (("manual", manual), ("auto", auto)):
        for key in _ordered_keys(list(tracks.keys()), requested, original):
            push(kind, tracks, key)

    return candidates


def _parse_vtt_timestamp(value: str) -> float | None:
    match = VTT_TS_RE.search(value)
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2))
    seconds = int(match.group(3))
    millis = int(match.group(4))
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def _srt_timestamp(seconds: float) -> str:
    millis = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(millis, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _format_srt(cues: list[tuple[float, float, str]]) -> str | None:
    if not cues:
        return None
    blocks = []
    for index, (start, end, text) in enumerate(cues, start=1):
        if end <= start:
            end = start + 0.5
        blocks.append(
            f"{index}\n{_srt_timestamp(start)} --> {_srt_timestamp(end)}\n{text.strip()}\n"
        )
    return "\n".join(blocks)


def _clean_cue_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\{\\[^}]+\}", "", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def vtt_to_srt(raw: str) -> str | None:
    """Convert WebVTT to SRT (fallback for tracks without an SRT rendition)."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    cues: list[tuple[float, float, str]] = []

    for block in re.split(r"\n\s*\n", text):
        lines = [line for line in block.split("\n") if line.strip()]
        if not lines:
            continue

        timestamp_index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if timestamp_index is None:
            continue

        parts = lines[timestamp_index].split("-->", 1)
        if len(parts) != 2:
            continue

        start = _parse_vtt_timestamp(parts[0])
        end = _parse_vtt_timestamp(parts[1].split()[0] if parts[1].split() else parts[1])
        if start is None or end is None:
            continue

        cue_text = _clean_cue_text(" ".join(lines[timestamp_index + 1:]))
        if not cue_text:
            continue

        # YouTube's rolling auto-captions repeat the same line in consecutive
        # cues.  Collapse those without destroying legitimate repeated lines.
        if cues and cues[-1][2] == cue_text:
            prev_start, prev_end, prev_text = cues[-1]
            cues[-1] = (prev_start, max(prev_end, end), prev_text)
        else:
            cues.append((start, end, cue_text))

    return _format_srt(cues)


def json3_to_srt(raw: str) -> str | None:
    """Convert YouTube's json3 caption format to SRT."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None

    cues: list[tuple[float, float, str]] = []
    for event in data.get("events", []):
        segments = event.get("segs") or []
        start_ms = event.get("tStartMs")
        duration_ms = event.get("dDurationMs") or 0
        if start_ms is None or not segments:
            continue

        cue_text = _clean_cue_text(
            "".join(segment.get("utf8", "") for segment in segments).replace("\n", " ")
        )
        if not cue_text:
            continue

        start = float(start_ms) / 1000
        end = float(start_ms + duration_ms) / 1000
        if cues and cues[-1][2] == cue_text and start <= cues[-1][1] + 0.05:
            prev_start, prev_end, prev_text = cues[-1]
            cues[-1] = (prev_start, max(prev_end, end), prev_text)
        else:
            cues.append((start, end, cue_text))

    return _format_srt(cues)


def normalize_srt(raw: str) -> str | None:
    text = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not SRT_TIME_RE.search(text):
        return None
    return text + "\n"


def _format_priority(fmt: dict[str, Any]) -> int:
    ext = (fmt.get("ext") or "").lower()
    return {"srt": 0, "vtt": 1, "json3": 2}.get(ext, 99)


def fetch_track_text(ydl: yt_dlp.YoutubeDL, formats: list[dict[str, Any]]) -> str | None:
    """Download the first usable rendition of a subtitle track."""
    for fmt in sorted(formats, key=_format_priority):
        ext = (fmt.get("ext") or "").lower()
        url = fmt.get("url")
        if ext not in {"srt", "vtt", "json3"} or not url:
            continue

        try:
            response = ydl.urlopen(url)
            payload = response.read()
        except Exception as exc:  # try the next rendition
            print(f"[subs] rendition {ext} failed: {exc}", flush=True)
            continue

        if not payload:
            continue

        raw = payload.decode("utf-8-sig", errors="replace").strip()
        if not raw:
            continue

        if ext == "srt":
            result = normalize_srt(raw)
        elif ext == "vtt":
            result = vtt_to_srt(raw)
        else:
            result = json3_to_srt(raw)

        if result:
            return result

    return None


# ---------------------------------------------------------------------------
# Cache + fetch
# ---------------------------------------------------------------------------

def _cache_paths(video_id: str, lang: str) -> tuple[Path, Path]:
    stem = f"{video_id}.{safe_lang(lang)}"
    return CACHE_DIR / f"{stem}.json", CACHE_DIR / f"{stem}.srt"


def _read_cache(video_id: str, lang: str, refresh: bool) -> dict[str, Any] | None:
    if refresh:
        return None

    json_path, _ = _cache_paths(video_id, lang)
    if not json_path.is_file():
        return None

    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    if data.get("version") != CACHE_VERSION:
        return None

    subtitle_file = data.get("subtitle_file")
    subtitle_text = None
    if subtitle_file:
        srt_path = (CACHE_DIR / subtitle_file).resolve()
        if srt_path.parent != CACHE_DIR.resolve() or not srt_path.is_file():
            return None
        try:
            subtitle_text = srt_path.read_text(encoding="utf-8")
        except OSError:
            return None
        if not SRT_TIME_RE.search(subtitle_text):
            return None

    data["subtitle"] = subtitle_text
    data["cached"] = True
    return data


def _write_cache(
    video_id: str,
    lang: str,
    data: dict[str, Any],
    subtitle_text: str | None,
) -> dict[str, Any]:
    json_path, srt_path = _cache_paths(video_id, lang)

    if subtitle_text:
        srt_tmp = srt_path.with_suffix(srt_path.suffix + ".tmp")
        srt_tmp.write_text(subtitle_text, encoding="utf-8")
        os.replace(srt_tmp, srt_path)
        data["subtitle_file"] = srt_path.name
    else:
        data["subtitle_file"] = None
        try:
            srt_path.unlink()
        except FileNotFoundError:
            pass

    json_tmp = json_path.with_suffix(json_path.suffix + ".tmp")
    json_tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(json_tmp, json_path)

    data["subtitle"] = subtitle_text
    data["cached"] = False
    return data


def get_or_fetch(video_id: str, lang: str = "en", refresh: bool = False) -> dict[str, Any]:
    cached = _read_cache(video_id, lang, refresh)
    if cached is not None:
        return cached

    with YDL_LOCK:
        # Another thread may have populated the cache while we waited.
        cached = _read_cache(video_id, lang, refresh)
        if cached is not None:
            return cached

        watch_url = f"https://www.youtube.com/watch?v={video_id}"
        options = {
            "skip_download": True,
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "socket_timeout": 25,
            "retries": 2,
            "extractor_retries": 1,
            "cachedir": str(CACHE_DIR / ".yt-dlp"),
        }

        print(f"[fetch] {video_id} (lang={lang!r})", flush=True)
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(watch_url, download=False)

            title = (info.get("title") or "").strip() or f"YouTube video {video_id}"
            subtitle_text = None
            chosen_lang = None
            auto = False

            for kind, track_lang, formats in subtitle_candidates(info, lang):
                subtitle_text = fetch_track_text(ydl, formats)
                if subtitle_text:
                    chosen_lang = track_lang
                    auto = kind == "auto"
                    break

        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        data: dict[str, Any] = {
            "version": CACHE_VERSION,
            "video_id": video_id,
            "title": title,
            "duration": info.get("duration"),
            "requested_language": lang,
            "language": chosen_lang,
            "auto": auto,
            "subtitle_file": None,
            "source_url": watch_url,
            "fetched_at": now,
        }

        if subtitle_text:
            print(
                f"[fetch] {video_id}: {len(subtitle_text)} chars, "
                f"{'auto' if auto else 'manual'} {chosen_lang}",
                flush=True,
            )
        else:
            print(f"[fetch] {video_id}: no subtitles found", flush=True)
            data["warning"] = "No subtitles were found for this video."

        return _write_cache(video_id, lang, data, subtitle_text)


def friendly_error(exc: BaseException) -> str:
    message = re.sub(r"\x1b\[[0-9;]*m", "", str(exc)).strip()
    message = re.sub(r"^ERROR:\s*", "", message, flags=re.IGNORECASE)
    lowered = message.lower()

    if "video unavailable" in lowered or "private video" in lowered:
        return "YouTube says this video is unavailable or private."
    if "sign in to confirm" in lowered or "not a bot" in lowered or "bot check" in lowered:
        return "YouTube blocked the request with a bot check. Try again later."
    if "age" in lowered and "confirm" in lowered:
        return "This video is age-restricted and yt-dlp needs cookies to access it."

    first_line = message.splitlines()[0] if message else "yt-dlp could not fetch this video."
    return first_line[:400]


# ---------------------------------------------------------------------------
# Optional punctuation/sentence-boundary formatter
# ---------------------------------------------------------------------------

class PunctuationFormatterUnavailable(RuntimeError):
    """Raised when the optional model tooling is not installed."""


def _formatter_path() -> Path:
    return ROOT / "tools" / "punctuation_format.py"


def _load_formatter():
    """Lazily import tools/punctuation_format.py so the base server has no
    hard dependency on onnxruntime/transformers."""
    global _FORMATTER, _FORMATTER_LOADED, _FORMATTER_LOAD_ERROR

    if _FORMATTER_LOADED:
        if _FORMATTER is None:
            raise PunctuationFormatterUnavailable(_FORMATTER_LOAD_ERROR or "Punctuation formatter is unavailable.")
        return _FORMATTER

    with FORMATTER_LOAD_LOCK:
        if _FORMATTER_LOADED:
            if _FORMATTER is None:
                raise PunctuationFormatterUnavailable(_FORMATTER_LOAD_ERROR or "Punctuation formatter is unavailable.")
            return _FORMATTER

        path = _formatter_path()
        if not path.is_file():
            _FORMATTER_LOADED = True
            _FORMATTER_LOAD_ERROR = (
                "Punctuation formatter is not installed. Add tools/punctuation_format.py "
                "and install tools/requirements-punctuation.txt."
            )
            raise PunctuationFormatterUnavailable(_FORMATTER_LOAD_ERROR)

        try:
            spec = importlib.util.spec_from_file_location("video_reader_punctuation_format", path)
            if spec is None or spec.loader is None:
                raise RuntimeError(f"could not load {path}")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            formatter = getattr(module, "format_cues", None) or getattr(module, "format_transcript", None)
            if not callable(formatter):
                raise RuntimeError("module does not export format_cues(cues)")
        except Exception as exc:  # dependency or model load failure
            _FORMATTER_LOADED = True
            _FORMATTER_LOAD_ERROR = f"Punctuation formatter failed to load: {exc}"
            raise PunctuationFormatterUnavailable(_FORMATTER_LOAD_ERROR) from exc

        _FORMATTER = formatter
        _FORMATTER_LOADED = True
        _FORMATTER_LOAD_ERROR = None
        print(f"[format] loaded {path}", flush=True)
        return _FORMATTER


def _format_cache_path(cues: list[dict[str, Any]]) -> tuple[Path, str]:
    canonical = json.dumps(cues, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]
    return CACHE_DIR / "format" / f"{digest}.json", digest


def _clean_sentence_ends(values: Any, cue_count: int) -> list[int]:
    if not isinstance(values, (list, tuple, set)):
        return []
    clean: set[int] = set()
    for value in values:
        try:
            index = int(value)
        except (TypeError, ValueError):
            continue
        if 0 <= index < cue_count:
            clean.add(index)
    return sorted(clean)


def _clean_paragraphs(values: Any, cue_count: int) -> list[list[int]] | None:
    if not isinstance(values, (list, tuple)):
        return None
    paragraphs: list[list[int]] = []
    for paragraph in values:
        if not isinstance(paragraph, (list, tuple)):
            continue
        group: list[int] = []
        for value in paragraph:
            try:
                index = int(value)
            except (TypeError, ValueError):
                continue
            if 0 <= index < cue_count:
                group.append(index)
        if group:
            paragraphs.append(group)
    return paragraphs or None


def format_transcript_cues(cues: list[dict[str, Any]], refresh: bool = False) -> dict[str, Any]:
    """Return sentence-end cue indices (and optional paragraph groups).

    Results are cached by a hash of the cue list, so repeated loads of the same
    transcript do not rerun the model.  The formatter contract is documented in
    tools/NOTES.md.
    """
    cache_path, digest = _format_cache_path(cues)

    def read_cache() -> dict[str, Any] | None:
        if refresh or not cache_path.is_file():
            return None
        try:
            data = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if data.get("version") != FORMAT_CACHE_VERSION or data.get("cues_hash") != digest:
            return None
        data["cached"] = True
        return data

    cached = read_cache()
    if cached is not None:
        return cached

    formatter = _load_formatter()

    with FORMAT_LOCK:
        cached = read_cache()
        if cached is not None:
            return cached

        result = formatter(cues)
        if not isinstance(result, dict):
            raise RuntimeError("formatter returned a non-object result")

        sentence_end_cues = _clean_sentence_ends(
            result.get("sentence_end_cues", result.get("breaks")), len(cues)
        )
        paragraphs = _clean_paragraphs(result.get("paragraphs"), len(cues))
        data: dict[str, Any] = {
            "version": FORMAT_CACHE_VERSION,
            "cues_hash": digest,
            "engine": str(result.get("engine") or "punctuation-model"),
            "sentence_end_cues": sentence_end_cues,
            "paragraphs": paragraphs,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "cached": False,
        }

        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, cache_path)
        return data


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class VideoReaderHandler(SimpleHTTPRequestHandler):
    server_version = "VideoReader/1.0"

    def do_OPTIONS(self):  # noqa: N802 (http.server naming)
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/youtube":
            self._handle_youtube_api()
            return
        if path == "/health":
            self._send_json({"ok": True}, HTTPStatus.OK)
            return
        if path == "/cache" or path.startswith("/cache/"):
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        super().do_GET()

    def do_POST(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/format":
            self._handle_format_api()
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def list_directory(self, path):  # noqa: N802
        # Never expose directory listings (especially not ./cache).
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")
        return None

    def _handle_youtube_api(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        raw = (query.get("url") or query.get("id") or [""])[0]
        lang = (query.get("lang") or ["en"])[0].strip() or "en"
        refresh = (query.get("refresh") or ["0"])[0].lower() in {"1", "true", "yes"}

        video_id = extract_video_id(raw)
        if not video_id:
            self._send_json(
                {
                    "ok": False,
                    "error": "Provide a valid YouTube URL or 11-character video ID.",
                },
                HTTPStatus.BAD_REQUEST,
            )
            return

        try:
            data = get_or_fetch(video_id, lang=lang, refresh=refresh)
        except Exception as exc:  # yt-dlp raises DownloadError and others
            print(f"[api] {video_id}: {type(exc).__name__}: {exc}", flush=True)
            self._send_json(
                {"ok": False, "error": friendly_error(exc)},
                HTTPStatus.BAD_GATEWAY,
            )
            return

        self._send_json({"ok": True, **data}, HTTPStatus.OK)

    def _handle_format_api(self):
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0

        if length <= 0:
            self._send_json(
                {"ok": False, "error": "POST a JSON body with a non-empty cues array."},
                HTTPStatus.BAD_REQUEST,
            )
            return
        if length > 4_000_000:
            self._send_json(
                {"ok": False, "error": "Transcript is too large (max 4 MB)."},
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            )
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._send_json(
                {"ok": False, "error": "Request body must be valid JSON."},
                HTTPStatus.BAD_REQUEST,
            )
            return

        if not isinstance(payload, dict):
            self._send_json(
                {"ok": False, "error": "Request body must be a JSON object."},
                HTTPStatus.BAD_REQUEST,
            )
            return

        raw_cues = payload.get("cues")
        if not isinstance(raw_cues, list) or not raw_cues:
            self._send_json(
                {"ok": False, "error": "cues must be a non-empty array."},
                HTTPStatus.BAD_REQUEST,
            )
            return
        if len(raw_cues) > 5000:
            self._send_json(
                {"ok": False, "error": "Too many cues (max 5000)."},
                HTTPStatus.BAD_REQUEST,
            )
            return

        cues: list[dict[str, Any]] = []
        for position, cue in enumerate(raw_cues):
            if not isinstance(cue, dict):
                continue
            text = str(cue.get("text") or "").strip()
            if not text:
                continue
            try:
                start = max(0.0, float(cue.get("start") or 0))
                end = max(start, float(cue.get("end") or start))
            except (TypeError, ValueError):
                continue
            try:
                index = int(cue.get("index", position))
            except (TypeError, ValueError):
                index = position
            cues.append({
                "index": index,
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text[:2000],
            })

        if not cues:
            self._send_json(
                {"ok": False, "error": "No usable cues were supplied."},
                HTTPStatus.BAD_REQUEST,
            )
            return

        refresh = payload.get("refresh") in (True, 1, "1", "true", "yes")
        try:
            data = format_transcript_cues(cues, refresh=refresh)
        except PunctuationFormatterUnavailable as exc:
            self._send_json({"ok": False, "error": str(exc)}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        except Exception as exc:
            print(f"[format] failed: {type(exc).__name__}: {exc}", flush=True)
            self._send_json(
                {"ok": False, "error": f"Punctuation formatting failed: {str(exc)[:400]}"},
                HTTPStatus.BAD_GATEWAY,
            )
            return

        self._send_json({"ok": True, **data}, HTTPStatus.OK)

    def _send_json(self, payload: dict[str, Any], status: int = HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Video Reader local server")
    parser.add_argument("--host", default="0.0.0.0", help="bind address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="port (default: 8000)")
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=ROOT / "cache",
        help="subtitle cache folder (default: ./cache)",
    )
    args = parser.parse_args()

    global CACHE_DIR
    CACHE_DIR = args.cache_dir.expanduser().resolve()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    handler = partial(VideoReaderHandler, directory=str(ROOT))

    try:
        with ThreadingHTTPServer((args.host, args.port), handler) as httpd:
            print(f"Video Reader: http://{args.host}:{args.port}/", flush=True)
            print(f"Subtitle cache: {CACHE_DIR}", flush=True)
            print("Press Ctrl-C to stop.", flush=True)
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
    except OSError as exc:
        print(f"Could not start server on {args.host}:{args.port}: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
