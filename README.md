# Video Reader

A single-file YouTube transcript reader. The video stays paused; scrolling or
hovering a transcript cue seeks to that cue. `index.html` contains all UI,
styling, SRT parsing, and playback logic.

## Run

```bash
python3 server.py
```

Open <http://localhost:8000/>. Use `--port` if 8000 is occupied:

```bash
python3 server.py --port 8001
```

Do not use `python3 -m http.server` for the full app. The plain static server
works for the page, but it has no `/api/youtube` endpoint, so the **Fetch**
button and automatic subtitle loading will fail.

## Load a source

Paste a YouTube URL, `youtu.be` link, embed/shorts URL, or 11-character video
ID and click **Fetch** in the Load Video & Subtitles dialog. The local server
uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to resolve the title and
subtitle track, then fills the title and SRT fields. Click **Render Article &
Sync Video**; if the SRT field is empty, Render also performs the fetch.

You can still drop or paste your own `.srt` file instead. `test.srt` is a
340-cue fixture for manual testing.

### Subtitle cache

Fetched subtitles are written to `cache/` next to `server.py`:

- `cache/<video-id>.<lang>.srt` — the SRT track
- `cache/<video-id>.<lang>.json` — title, language, auto/manual flag, duration,
  source URL, and fetch timestamp

A second request for the same video/language is served from disk without
hitting YouTube. To force a refresh:

```text
http://localhost:8000/api/youtube?url=<video-id>&lang=en&refresh=1
```

`cache/` is gitignored. The server refuses to serve directory listings or
files under `/cache/`; use the API instead.

## API

```text
GET /api/youtube?url=<YouTube URL or ID>&lang=en&refresh=0
GET /health
```

`/api/youtube` returns JSON with `ok`, `video_id`, `title`, `subtitle` (SRT
text or `null`), `language`, `auto`, `cached`, `duration`, and `subtitle_file`.
A video without captions still returns the title and `subtitle: null`.

```text
POST /api/format
Content-Type: application/json

{"cues":[{"index":0,"start":1.5,"end":3.7,"text":"hello there"}]}
```

`/api/format` is an optional model-backed helper. It returns
`sentence_end_cues` (cue indices where a sentence ends) and, when available,
`paragraphs` (arrays of cue indices). The client uses the hints with its own
grouping rules; transcript words are not rewritten. Results are cached under
`cache/format/`. If the optional formatter or its Python dependencies are not
installed, the endpoint returns `503` and the client keeps its deterministic
grouping. See `tools/NOTES.md` and `tools/requirements-punctuation.txt` for
the model setup.

## Tests

```bash
python3 -m unittest discover -s tests -v
```
