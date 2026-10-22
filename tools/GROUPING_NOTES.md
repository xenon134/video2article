# Sentence-aware paragraph grouping

`tools/grouping.js` is a deterministic, dependency-free paragraph grouper for
the cue shape already used by `index.html`:

```js
{ index, start, end, mid, text }
```

It replaces the current "push cues until 7 / break on `.?!` after 3 cues" rule
with a sentence-aware scorer. The module has no DOM dependency and does not
rewrite transcript text. `groupCues` returns arrays of the **original cue
objects**, so `index`, `start`, `end`, `mid`, and `text` remain untouched for
the existing hover/sync renderer.

## Files

| File | Purpose |
| --- | --- |
| `tools/grouping.js` | The reusable grouper + sentence-punctuation analyzer + optional cue splitter. |
| `tools/grouping_test.mjs` | Node harness over `test.srt` and `cache/M7lc1UVf-VE.en.srt`. |
| `tools/grouping_edge_test.mjs` | Small synthetic suite for speaker changes, pauses, hints, caps, long cues, etc. |
| `tools/GROUPING_NOTES.md` | This document. |

The module is a UMD-style plain script on purpose: it can be pasted into the
single-file app's existing inline `<script>`, loaded with a normal script tag
(exposes `globalThis.TranscriptGrouping`), or loaded from Node/CommonJS with
`require`. There is no build step.

## API

```js
const {
  paragraphs, // [[cue, ...], ...]
  meta,       // { paragraphInfo, sentenceEndCues, options }
} = TranscriptGrouping.groupCues(cues, options);
```

Each `meta.paragraphInfo[i]` record contains `startIndex`, `endIndex`, `start`,
`end`, `duration`, `chars`, `cueCount`, `sentenceCount`, `endsSentence`, and
`breakReason` (`sentence`, `sentence-pause`, `pause`, `speaker`, `fallback`,
or `final`).

Useful options (all optional):

```js
{
  sentenceEndCues: hints,        // Set/array/iterable of cue.index, or (cue, i) => bool
  minSentences: 2,
  targetSentences: 3,
  maxSentences: 4,
  minDuration: 9,                // seconds
  targetDuration: 27,
  targetMaxDuration: 35,
  maxDuration: 40,
  minCues: 2,
  maxCues: 14,
  targetChars: 280,
  maxChars: 450,
  pauseThreshold: 1.5,
  speakerChanges: true,
  autoCaptionSpeakerMarkers: true,
  mergeTinyParagraphs: true,
}
```

Other exports:

```js
TranscriptGrouping.analyzeSentencePunctuation(text)
// -> { count, positions, endsSentence }

TranscriptGrouping.splitCueIntoSentenceUnits(cue)
// -> [{ ...cue, text, index, start, end, mid, unitIndex, unitCount, cueStart, cueEnd }]
```

`splitCueIntoSentenceUnits` is optional and is not used by `groupCues` by
default. It splits a multi-sentence cue at its internal sentence ends using
proportional character timing. Every unit keeps the original `cue.index` and
the original cue range as `cueStart`/`cueEnd`. Do not feed those units back into
`groupCues` without deciding how to disambiguate duplicate indices; the main
grouper is deliberately cue-granular so the current renderer/sync model stays
simple.

## Rules

### 1. Detect sentence ends at cue granularity

A cue can contain zero, one, or several sentence endings. The analyzer:

- counts runs of `.` `?` `!` followed by whitespace or end of cue;
- counts `?!` / `!?` as one ending;
- skips decimal points (`3.14`) and common abbreviations (`Mr.`, `Dr.`, `St.`,
  `U.S.`, `e.g.`, `etc.`, `Inc.`, `No.`, initials, etc.);
- skips `[? ... ?]` transcription annotations;
- treats a trailing ellipsis as a weak terminal, but not a mid-cue ellipsis;
- marks `endsSentence` only when the last ending reaches the end of the cue.

An optional `sentenceEndCues` hint can fill in a missing cue-end boundary from
an LM or a better punctuation model. A hint does not double-count a cue that
already ends in punctuation.

### 2. Detect speaker turns

At the start of a cue:

- `JEFF POSNICK: ...` is a named speaker label;
- `>> ...` is an auto-caption turn marker.

A different labelled speaker forces a paragraph break. Repeating the same
label, or continuing unlabelled text, does not. Consecutive `>>` cues are
treated as the same opaque turn; a `>>` after unlabelled text starts a new
turn. Labels are left in the text exactly as-is. If a source uses consecutive
`>>` markers for different speakers, preprocess/split those turns yourself.

### 3. Pick a paragraph end by scoring candidate cue boundaries

For each paragraph start, the grouper considers possible end cues up to the
hard caps and selects the lowest-cost candidate. The cost is deterministic and
has four parts:

1. **Sentence boundary preference** — a cue ending in a sentence (punctuation
   or hint) gets a large bonus. A pause gets a smaller bonus. A fallback cut
   gets a penalty.
2. **Size preference** — target ~27s, ~3 sentences, ~280 chars; 20-35s is the
   comfortable duration band.
3. **Minimum-size penalty** — punctuation-only breaks below ~9s are strongly
   discouraged. Short final/speaker-forced paragraphs are allowed.
4. **Boundary quality** — small nudges for cue-end commas/colons, a capitalised
   next cue, no function-word ending, and a following lowercase continuation.

Hard caps are 40s, 450 characters, and 14 cues. A single cue larger than the
caps is still emitted as its own paragraph (the grouper never drops text).

This is a bounded look-ahead of at most `maxCues` cues per paragraph, not a
global dynamic-programming pass. It is `O(n * maxCues)`, deterministic, and easy
to reason about.

### 4. Break at pauses

A gap of at least `pauseThreshold` (default 1.5s) at a sentence boundary is a
strong natural break. A large pause can also produce a fallback break even when
punctuation is missing. A tiny paragraph created right before a large pause is
not merged away.

### 5. Fold accidental micro-paragraphs

The scorer is already reluctant to make tiny paragraphs, but a closing line
like `Cheers.` can still end up alone. A post-pass merges a sub-6s (or
single-cue sub-9s) paragraph into a neighbour when:

- there is no speaker change at the boundary,
- there is no pause >= `pauseThreshold` at the boundary,
- the combined paragraph still fits under the hard caps.

Set `mergeTinyParagraphs: false` if standalone closing lines are desired.

### 6. Unpunctuated fallback

Auto-generated captions often have no punctuation at all. In that case sentence
counts stay at zero, and the grouper falls back to:

- pause detection (strongest signal),
- duration/character/cue targets and hard caps,
- mild phrase-boundary hints: avoid ending on a function word, prefer a
  capitalised next cue, avoid a lowercase continuation.

It deliberately does **not** use a long list of discourse markers to invent
sentence ends. Without a real LM, some fallback cuts will land mid-sentence;
the harness measures exactly that. The fallback is deliberately boring rather
than overfitted to one transcript.

## Harness results

Run:

```sh
node tools/grouping_test.mjs
node tools/grouping_edge_test.mjs
```

`test.srt` (340 cues, 12.5 min, 11.8% of cues end in punctuation):

| | old live rule | new, no hints | new, heuristic hints |
| --- | ---: | ---: | ---: |
| paragraphs | 57 | 39 | 40 |
| duration min / median / max | 3.2 / 13.9 / 17.3s | 8.3 / 19.0 / 27.6s | 8.3 / 18.4 / 25.9s |
| chars median | 253 | 343 | 333 |
| cues median | 7 | 9 | 9 |
| sentence endings median | 2 | 4 | 4 |
| mid-sentence breaks | 34 / 56 (60.7%) | 17 / 38 (44.7%) | 16 / 39 (41.0%) |

`cache/M7lc1UVf-VE.en.srt` (466 cues, manual subtitles, 50.4% terminal):

| | old live rule | new, no hints | new, heuristic hints |
| --- | ---: | ---: | ---: |
| paragraphs | 123 | 68 | 68 |
| duration min / median / max | 5.2 / 10.4 / 21.6s | 7.2 / 19.2 / 28.3s | 7.2 / 19.2 / 28.3s |
| chars median | 154 | 298 | 298 |
| cues median | 4 | 7 | 7 |
| sentence endings median | 2 | 4 | 4 |
| mid-sentence breaks | 0 / 122 (0.0%) | 0 / 67 (0.0%) | 0 / 67 (0.0%) |

The "old live rule" is the exact current `index.html` loop (7-cue cap plus
early break at terminal punctuation after 3 cues or a >1.5s gap). For
reference, a pure 7-cue cap without the early punctuation break would be 49
paragraphs for `test.srt` and 67 for the manual fixture; the live rule produces
57 and 123 because punctuation ends paragraphs much earlier.

The manual fixture is already well punctuated, so sentence hints add nothing
there. The auto fixture gains a small amount from conservative heuristic hints;
a real LM that marks missing cue-end sentence boundaries should help more.

## Recommended integration

In the single-file app, load/paste the module so `TranscriptGrouping` is
available, then replace only the old `currentPara` grouping loop:

```html
<script src="tools/grouping.js"></script>
<script>
  // `segments` is the existing parseSrtContent output.
  const { paragraphs } = TranscriptGrouping.groupCues(segments, {
    // Optional: Set/array of cue.index values where an LM says a sentence ends.
    sentenceEndCues: window.sentenceEndHints || null,
    // Defaults shown for clarity; omit them to use the module defaults.
    targetDuration: 27,
    maxDuration: 40,
    maxCues: 14,
    maxChars: 450,
    pauseThreshold: 1.5,
  });

  // Keep the existing DOM building code; just iterate the new groups.
  paragraphs.forEach((paraSegments) => {
    const p = document.createElement('p');
    // ... existing paraSegments.forEach(seg => span ...)
  });
</script>
```

If everything is inlined in the single-file HTML, paste the body of
`tools/grouping.js` before the main inline script (or inside it) and call
`TranscriptGrouping.groupCues(...)` / destructure `groupCues` from it. There is
no DOM access and no dependency to add.

The output deliberately preserves cue identity, so the existing
`span.dataset.index/start/end/mid`, hover handlers, and scroll sync continue to
work unchanged.

## Tuning

- **Shorter mobile-friendly paragraphs:** `targetDuration: 22`,
  `targetMaxDuration: 30`, `maxChars: 380`. This will create more paragraphs
  but keep them closer to 2-3 sentences.
- **Noisier auto captions / unreliable ASR:** raise `pauseThreshold` to
  1.8-2.0 so short gaps do not create breaks. Do not lower the min-duration
  guard.
- **A good LM sentence classifier:** pass every cue index where the LM thinks a
  sentence ends as `sentenceEndCues`. Keep the duration/cue/char caps; hints
  should guide boundaries, not remove the safety net.
- **Standalone closing lines:** `mergeTinyParagraphs: false`.
- **Speaker-heavy content:** labels and `>>` already force breaks. If a source
  uses consecutive `>>` markers for different speakers, pre-split those cues or
  turn off `autoCaptionSpeakerMarkers` and provide explicit labels.

## Caveats

- Paragraphs are cue-granular. A cue that contains several sentences stays in
  one paragraph unless the caller uses `splitCueIntoSentenceUnits` first. This
  is intentional: splitting cues would create duplicate `cue.index` values and
  complicate the existing one-span-per-cue renderer/sync.
- `endsSentence` is a heuristic analyzer, not a parser. Quoted speech,
  abbreviations, URLs, and unusual punctuation can be misclassified. Hints are
  the escape hatch.
- The fallback cannot recover information that is absent. Auto-caption text
  with no punctuation will still contain some mid-sentence cuts; the harness
  reports the rate rather than hiding it.
- The scorer chooses among candidates up to the hard caps; it is not globally
  optimal. This keeps the code small and deterministic.
- A single cue longer than 40s (or 450 chars / 14 cues) becomes its own
  paragraph rather than being split or dropped.
