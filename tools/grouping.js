/*
 * tools/grouping.js
 * ---------------------------------------------------------------------------
 * Deterministic, sentence-aware paragraph grouping for SRT-style cues.
 *
 * This file has no DOM dependencies and no third-party dependencies. It is a
 * UMD-style plain script:
 *   - Browser classic script:  <script src="tools/grouping.js"></script>
 *                              -> window.TranscriptGrouping
 *   - CommonJS / Node:         const G = require('./tools/grouping.js')
 *
 * There is no build step and no module-loader requirement.
 *
 * Cue shape expected (the same shape index.html already produces):
 *   { index: number, start: seconds, end: seconds, mid: seconds, text: string }
 *
 * The original cue objects are never mutated. Paragraphs contain references to
 * the original cue objects, so `index`, `start`, `end`, and `text` are preserved
 * exactly for the existing renderer / synchronization engine.
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
    'use strict';

    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.TranscriptGrouping = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /********************************************************************
     * DEFAULTS
     *
     * The defaults intentionally describe a *range*, not a fixed size:
     *   - 2-4 sentence endings is the preferred semantic size.
     *   - 20-35 seconds is the preferred readable size.
     *   - 40s / 450 chars / 14 cues are hard caps.
     *
     * Auto-generated captions often have almost no punctuation. In that case
     * sentence counts stay at zero and the duration/char/cue limits plus the
     * boundary-quality score take over.
     ********************************************************************/
    const DEFAULTS = Object.freeze({
        // Sentence-count targets (when punctuation / hints make sentences visible)
        minSentences: 2,
        targetSentences: 3,
        maxSentences: 4,

        // Time and size targets
        minDuration: 9.0,          // don't break for punctuation alone below ~9s
        targetDuration: 27.0,      // middle of the 20-35s readable range
        targetMaxDuration: 35.0,
        maxDuration: 40.0,
        minCues: 2,
        maxCues: 14,
        targetChars: 280,
        maxChars: 450,

        // Pauses. A pause at/above this threshold is treated as a likely
        // sentence/turn boundary even when punctuation is missing.
        pauseThreshold: 1.5,

        // Optional hint source: iterable of cue indices, or a predicate
        // (cue, position) => boolean. Hints are the intended hook for an LM
        // sentence-end detector.
        sentenceEndCues: null,

        // Speaker labels ("JEFF POSNICK: ...") and auto-caption ">>" markers.
        speakerChanges: true,
        autoCaptionSpeakerMarkers: true,

        // Fold an accidental one-cue or sub-6s paragraph into a neighbour when
        // there is no speaker change or large pause at the boundary.
        mergeTinyParagraphs: true,
    });

    /********************************************************************
     * PUNCTUATION ANALYSIS
     ********************************************************************/

    // Abbreviations whose period is not a sentence end when followed by a
    // name/number. The set is deliberately conservative: it only suppresses a
    // period when there is clearly more text after it.
    const TITLE_ABBREVIATIONS = new Set([
        'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft',
        'gen', 'gov', 'sen', 'rep', 'rev', 'hon', 'capt', 'sgt', 'col',
        'lt', 'cmdr', 'adm', 'pres', 'supt', 'det', 'insp', 'messrs',
        'mmes', 'dept', 'est', 'ave', 'blvd', 'rd',
        'no', 'fig', 'vol', 'pp', 'cf', 'resp', 'al', 'ed', 'trans',
    ]);

    // These can be sentence-final, but are also commonly followed by more
    // text. We only suppress them when the next word is lowercase.
    const CONTINUATION_ABBREVIATIONS = new Set([
        'etc', 'e.g', 'i.e', 'u.s', 'u.k', 'u.n', 'a.m', 'p.m', 'vs',
        'inc', 'ltd', 'co', 'corp', 'plc',
    ]);

    const FUNCTION_WORD_ENDINGS = new Set([
        'a', 'an', 'the', 'and', 'or', 'but', 'if', 'because', 'so',
        'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as',
        'than', 'that', 'which', 'who', 'whom', 'whose', 'is', 'are',
        'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
        'have', 'has', 'had', 'will', 'would', 'can', 'could', 'shall',
        'should', 'may', 'might', 'must', 'not', 'into', 'onto', 'over',
        'under', 'after', 'before', 'while', 'when', 'where', 'why',
        'how', 'this', 'these', 'those', 'my', 'your', 'his', 'her',
        'its', 'our', 'their', 'me', 'him', 'them', 'us', 'there',
        'here', 'about', 'like', 'just', 'very', 'really', 'also',
        'then', 'now', 'something', 'anything', 'everything', 'nothing',
        'some', 'any', 'all', 'more', 'most', 'much', 'many',
    ]);

    const SPEAKER_LABEL_RE = /^\s*([A-Z][A-Z0-9 .'&()\/-]{1,40}):\s+/;
    const AUTO_SPEAKER_RE = /^\s*>>\s*/;

    /**
     * Returns true when `index` falls inside a caption annotation such as
     * `[? inaudible ?]`. Those question marks are transcription flags, not
     * sentence punctuation.
     */
    function isInsideUncertainAnnotation(text, index) {
        const open = text.lastIndexOf('[', index);
        if (open === -1) return false;
        const close = text.indexOf(']', open);
        if (close === -1) return false;
        if (index > close) return false;
        const inside = text.slice(open, close + 1);
        return inside.indexOf('?') !== -1;
    }

    function previousToken(text, dotIndex) {
        let i = dotIndex - 1;
        while (i >= 0 && /[A-Za-z0-9.'’]/.test(text[i])) i--;
        return text.slice(i + 1, dotIndex);
    }

    function nextNonSpaceChar(text, fromIndex) {
        for (let i = fromIndex; i < text.length; i++) {
            if (!/\s/.test(text[i])) return { char: text[i], index: i };
        }
        return null;
    }

    function nextToken(text, fromIndex) {
        const next = nextNonSpaceChar(text, fromIndex);
        if (!next) return null;
        let end = next.index;
        while (end < text.length && !/\s/.test(text[end])) end++;
        return text.slice(next.index, end);
    }

    /**
     * Decide whether a single `.` is part of an abbreviation / decimal.
     * Returns one of: 'terminal' | 'skip' | 'maybe'.
     */
    function classifySinglePeriod(text, dotIndex, runLength) {
        const prevChar = dotIndex > 0 ? text[dotIndex - 1] : '';
        const nextChar = dotIndex + 1 < text.length ? text[dotIndex + 1] : '';

        // Decimal: 3.14, 1.5s
        if (/[0-9]/.test(prevChar) && /[0-9]/.test(nextChar)) return 'skip';

        // Three or more periods are an ellipsis. Treat it as a terminal only
        // when it ends the cue (a trailing-off sentence), never mid-cue.
        if (runLength >= 3) {
            const after = nextNonSpaceChar(text, dotIndex + runLength);
            return after ? 'skip' : 'terminal';
        }

        // "..." / ". . ." style is handled above for the compact form. Two
        // dots are rare; treat them as a weak terminal.
        if (runLength === 2) return 'terminal';

        const token = previousToken(text, dotIndex);
        const lower = token.toLowerCase();
        const after = nextNonSpaceChar(text, dotIndex + 1);

        // A period with no following text is a cue-ending punctuation mark.
        if (!after) {
            if (TITLE_ABBREVIATIONS.has(lower) || CONTINUATION_ABBREVIATIONS.has(lower)) {
                return 'terminal';
            }
            // Single-letter initial at the very end ("J.") is uncommon in
            // subtitles; treating it as terminal is the safer cue boundary.
            return 'terminal';
        }

        if (TITLE_ABBREVIATIONS.has(lower)) return 'skip';

        if (CONTINUATION_ABBREVIATIONS.has(lower)) {
            // "U.S. It is..." ends a sentence; "etc. and..." does not.
            return /^[A-Z0-9"'“”‘’([]/.test(after.char) ? 'terminal' : 'skip';
        }

        // Initials: "J. K. Rowling". Suppress only when followed by another
        // capitalised name-like token.
        if (/^[A-Z]$/.test(token) && /^[A-Z]/.test(after.char)) return 'skip';

        return 'terminal';
    }

    /**
     * Find valid sentence-ending punctuation runs in a cue.
     *
     * Returns:
     *   count        number of sentence endings
     *   positions    indices immediately AFTER each ending (including closers)
     *   endsSentence true when the last ending reaches the end of the cue
     *
     * This is exported for harnesses / LM pre-processing; groupCues uses it
     * internally as well.
     */
    function analyzeSentencePunctuation(text) {
        const source = String(text || '');
        const positions = [];
        let count = 0;

        // A run of . ! ? followed by closing quotes/brackets, and then either
        // whitespace or the end of the cue.
        const re = /([.!?]+)([)"'”’»\]]*)(?=\s|$)/g;
        let match;

        while ((match = re.exec(source)) !== null) {
            const run = match[1];
            const runStart = match.index;
            const endIndex = match.index + match[0].length;

            if (isInsideUncertainAnnotation(source, runStart)) continue;

            let isTerminal = false;

            if (/[!?]/.test(run)) {
                // ! and ? are strong terminals. "?!" is one ending.
                isTerminal = true;
            } else {
                const cls = classifySinglePeriod(source, runStart, run.length);
                isTerminal = cls === 'terminal';
            }

            if (isTerminal) {
                count += 1;
                positions.push(endIndex);
            }
        }

        const trimmedEnd = source.replace(/\s+$/, '').length;
        const endsSentence = positions.length > 0 &&
            positions[positions.length - 1] >= trimmedEnd;

        return { count, positions, endsSentence };
    }

    /********************************************************************
     * SPEAKER DETECTION
     ********************************************************************/

    function detectSpeakerLabel(text, autoCaptionSpeakerMarkers) {
        const source = String(text || '');

        if (autoCaptionSpeakerMarkers) {
            if (AUTO_SPEAKER_RE.test(source)) {
                // Every ">>" is an opaque turn marker. Consecutive ">>" cues
                // are treated as the same turn so a multi-cue turn does not get
                // shredded into one-line paragraphs.
                return { id: '__auto_turn__', label: '>>' };
            }
        }

        const m = source.match(SPEAKER_LABEL_RE);
        if (m) {
            return { id: m[1].trim().toUpperCase(), label: m[1].trim() };
        }

        return null;
    }

    /********************************************************************
     * CUE ANALYSIS
     ********************************************************************/

    function normalizeHintSource(hints) {
        if (hints == null) return null;
        if (typeof hints === 'function') return hints;
        if (hints instanceof Set) return (cue) => hints.has(cue.index);
        if (Array.isArray(hints)) {
            const set = new Set(hints);
            return (cue) => set.has(cue.index);
        }
        if (typeof hints[Symbol.iterator] === 'function') {
            const set = new Set(hints);
            return (cue) => set.has(cue.index);
        }
        throw new TypeError('sentenceEndCues must be a Set, an array, an iterable, or a predicate function');
    }

    function analyzeCues(cues, options, hintPredicate) {
        const rows = [];
        let previousSpeaker = null;

        for (let i = 0; i < cues.length; i++) {
            const cue = cues[i];
            const text = String(cue.text || '');
            const punctuation = analyzeSentencePunctuation(text);
            const hinted = hintPredicate ? !!hintPredicate(cue, i) : false;

            // A hint can fill in a missing sentence end, but must not double
            // count a cue that already ends in terminal punctuation.
            const sentenceEndCount = punctuation.count + (hinted && !punctuation.endsSentence ? 1 : 0);
            const endsSentence = punctuation.endsSentence || hinted;

            const label = options.speakerChanges
                ? detectSpeakerLabel(text, options.autoCaptionSpeakerMarkers)
                : null;
            const effectiveSpeaker = label ? label.id : previousSpeaker;
            // A label after unlabeled text starts a new turn, but the very
            // first cue of the transcript never needs a leading blank break.
            const speakerChange = !!(label && i > 0 && (!previousSpeaker || label.id !== previousSpeaker));

            if (label) previousSpeaker = label.id;

            const previous = i > 0 ? rows[i - 1] : null;
            const gapBefore = previous ? Math.max(0, cue.start - previous.cue.end) : 0;

            rows.push({
                cue,
                position: i,
                text,
                punctuation,
                hinted,
                sentenceEndCount,
                endsSentence,
                speaker: effectiveSpeaker,
                speakerLabel: label ? label.label : null,
                speakerChange,
                gapBefore,
                lastWord: (text.match(/[A-Za-z0-9'’]+(?=[^A-Za-z0-9'’]*$)/) || [''])[0],
                firstWord: (text.replace(AUTO_SPEAKER_RE, '').trim().match(/^[A-Za-z0-9'’]+/) || [''])[0],
            });
        }

        return rows;
    }

    function endsWithFunctionWord(row) {
        const word = row.lastWord.toLowerCase();
        return !!word && FUNCTION_WORD_ENDINGS.has(word);
    }

    function startsWithLowercase(row) {
        return /^[a-z]/.test(row.firstWord || '');
    }

    function startsWithUppercase(row) {
        return /^[A-Z]/.test(row.firstWord || '');
    }

    /**
     * Quality of a break after row `i`, ignoring paragraph-size targets.
     * Higher is better. This is intentionally a small, auditable heuristic,
     * not a language model.
     */
    function boundaryQuality(rows, i, options) {
        const row = rows[i];
        const next = rows[i + 1];
        if (!next) return 0;

        const gap = Math.max(0, next.cue.start - row.cue.end);
        let score = 0;

        if (row.endsSentence) score += 60;
        if (gap >= options.pauseThreshold) score += row.endsSentence ? 25 : 35;
        else if (gap >= 0.8) score += 10;

        if (!row.endsSentence) {
            if (/[,;:—–-]\s*$/.test(row.text)) score += 8;
            if (startsWithUppercase(next)) score += 5;
            if (startsWithLowercase(next)) score -= 10;
            if (endsWithFunctionWord(row)) score -= 16;
            if (row.sentenceEndCount > 0) score += 4;
        }

        if (next.speakerChange) score += 1000;
        return score;
    }

    function paragraphTextStats(rows, start, end) {
        let chars = 0;
        let sentenceCount = 0;
        for (let i = start; i <= end; i++) {
            chars += rows[i].text.length;
            sentenceCount += rows[i].sentenceEndCount;
        }
        if (end > start) chars += end - start; // spaces between cue texts
        return {
            chars,
            sentenceCount,
            duration: rows[end].cue.end - rows[start].cue.start,
            cueCount: end - start + 1,
        };
    }

    function canEndHere(rows, start, end, options) {
        const next = rows[end + 1];
        if (!next) return true;
        if (next.speakerChange) return true;
        if (end - start + 1 < options.minCues) return false;
        return true;
    }

    /**
     * Score one possible paragraph end. Lower is better.
     *
     * The score combines:
     *   - preference for a real sentence boundary (big negative cost),
     *   - proximity to the 20-35s / 2-4 sentence target,
     *   - penalties for cramped or overlong paragraphs,
     *   - boundary quality (pause, phrase closure, next word case).
     */
    function scoreParagraphEnd(rows, start, end, options) {
        const stats = paragraphTextStats(rows, start, end);
        const next = rows[end + 1];
        const last = rows[end];
        const isFinal = !next;
        const forcedSpeaker = !!(next && next.speakerChange);
        const gap = next ? Math.max(0, next.cue.start - last.cue.end) : 0;
        const pause = !!next && gap >= options.pauseThreshold;

        let cost = 0;

        // ---- Duration preference -----------------------------------------
        if (stats.duration < options.minDuration) {
            // Strong penalty, but final/speaker-forced paragraphs are allowed
            // to be short because there is no alternative.
            if (!isFinal && !forcedSpeaker) {
                const shortfall = options.minDuration - stats.duration;
                cost += shortfall * shortfall * 25;
            }
        } else if (stats.duration < 20) {
            cost += (20 - stats.duration) * 2;
        } else if (stats.duration > options.targetMaxDuration) {
            cost += (stats.duration - options.targetMaxDuration) * 5;
        } else {
            cost += Math.abs(stats.duration - options.targetDuration) * 0.8;
        }

        // ---- Sentence-count preference -----------------------------------
        if (stats.sentenceCount < options.minSentences) {
            cost += (options.minSentences - stats.sentenceCount) * 30;
        } else if (stats.sentenceCount > options.maxSentences) {
            cost += (stats.sentenceCount - options.maxSentences) * 20;
        }
        cost += Math.abs(stats.sentenceCount - options.targetSentences) * 2;

        // ---- Character preference ----------------------------------------
        if (stats.chars > options.maxChars) {
            cost += (stats.chars - options.maxChars) * 2;
        } else {
            cost += Math.abs(stats.chars - options.targetChars) * 0.02;
        }

        // ---- Boundary preference -----------------------------------------
        if (last.endsSentence) {
            cost -= 60;
        } else if (pause) {
            cost -= 30;
        } else {
            // A non-sentence, non-pause break is a fallback cut. Prefer one
            // with some phrase closure, but never pretend it is a sentence.
            cost += 25;
            if (/[,;:—–-]\s*$/.test(last.text)) cost -= 8;
            if (next && startsWithUppercase(next)) cost -= 4;
            if (next && startsWithLowercase(next)) cost += 6;
            if (endsWithFunctionWord(last)) cost += 10;
        }

        // A pause at a sentence boundary is one of the strongest natural
        // breaks we can detect, so let it beat the ordinary size target even
        // when the paragraph is only ~8-10s long.
        if (pause && last.endsSentence) cost -= 30;

        // Boundary quality is a tie-breaker; keep its influence small.
        cost -= boundaryQuality(rows, end, options) * 0.1;

        // If this end is forced by a speaker change, make sure it wins over
        // any earlier candidate (the loop will restrict candidates anyway).
        if (forcedSpeaker) cost -= 1000;

        return { cost, stats, pause, forcedSpeaker, isFinal };
    }

    /**
     * Choose the end (inclusive index) of the paragraph beginning at `start`.
     *
     * Candidate ends are constrained by:
     *   - hard caps (maxCues / maxDuration / maxChars),
     *   - the next speaker change (paragraph must end before it),
     *   - minCues unless this is a forced/final paragraph.
     *
     * Among the remaining candidates we pick the lowest cost. This gives a
     * bounded look-ahead of at most `maxCues` cues without requiring a full
     * dynamic-programming pass.
     */
    function chooseParagraphEnd(rows, start, options) {
        const n = rows.length;
        let limit = start;
        let chars = 0;

        for (let i = start; i < n; i++) {
            const row = rows[i];
            chars += row.text.length + (i > start ? 1 : 0);
            const cueCount = i - start + 1;
            const duration = row.cue.end - rows[start].cue.start;

            // A speaker change forces the previous paragraph to end here.
            if (i > start && row.speakerChange) {
                limit = i - 1;
                break;
            }

            // A single cue is always allowed to exceed the caps; otherwise
            // stop just before the cap is crossed.
            if (cueCount > options.maxCues ||
                duration > options.maxDuration ||
                chars > options.maxChars) {
                if (i === start) {
                    limit = i;
                } else {
                    limit = i - 1;
                }
                break;
            }

            limit = i;
        }

        // The next cue starts a new speaker: don't let the search cross it.
        if (limit + 1 < n && rows[limit + 1].speakerChange) {
            // limit already points at the cue before the change
        }

        let from = start;
        if (limit > start && canEndHere(rows, start, start + options.minCues - 1, options)) {
            from = Math.min(start + options.minCues - 1, limit);
        }
        // If the paragraph is very short and forced/final, `from` stays at
        // start so the only legal candidate is available.

        let best = null;
        const trace = options.debug ? [] : null;
        for (let end = from; end <= limit; end++) {
            if (end > start && !canEndHere(rows, start, end, options)) continue;
            const scored = scoreParagraphEnd(rows, start, end, options);
            if (trace) {
                trace.push({
                    end,
                    cueIndex: rows[end].cue.index,
                    duration: Number(scored.stats.duration.toFixed(3)),
                    cueCount: scored.stats.cueCount,
                    chars: scored.stats.chars,
                    sentenceCount: scored.stats.sentenceCount,
                    endsSentence: rows[end].endsSentence,
                    pause: scored.pause,
                    cost: Number(scored.cost.toFixed(3)),
                });
            }
            if (!best || scored.cost < best.scored.cost - 1e-9) {
                best = { end, scored, trace };
            } else if (Math.abs(scored.cost - best.scored.cost) < 1e-9) {
                // Deterministic tie-break: prefer a sentence boundary, then the
                // later (longer) candidate so we do not create unnecessary
                // micro-paragraphs.
                const bestSentence = rows[best.end].endsSentence;
                const thisSentence = rows[end].endsSentence;
                if ((thisSentence && !bestSentence) || (thisSentence === bestSentence && end > best.end)) {
                    best = { end, scored };
                }
            }
        }

        if (best) {
            if (trace) best.trace = trace;
            return best;
        }
        return {
            end: limit,
            scored: scoreParagraphEnd(rows, start, limit, options),
            trace: trace || undefined,
        };
    }

    function describeBreak(rows, end, options) {
        const next = rows[end + 1];
        if (!next) return 'final';
        if (next.speakerChange) return 'speaker';
        const last = rows[end];
        const gap = Math.max(0, next.cue.start - last.cue.end);
        if (last.endsSentence) return gap >= options.pauseThreshold ? 'sentence-pause' : 'sentence';
        if (gap >= options.pauseThreshold) return 'pause';
        return 'fallback';
    }

    /********************************************************************
     * PUBLIC API
     ********************************************************************/

    /**
     * Split a cue at its internal sentence boundaries using proportional
     * character timing. Useful when a cue contains several sentences and the
     * caller wants sub-cue granularity.
     *
     * Every unit keeps:
     *   - the original cue index (`index`),
     *   - its own proportional `start`/`end`/`mid`,
     *   - the original cue range as `cueStart`/`cueEnd`.
     *
     * The text is a slice of the original text (only outer whitespace is
     * trimmed); it is never rewritten.
     */
    function splitCueIntoSentenceUnits(cue, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const text = String(cue.text || '');
        const analysis = analyzeSentencePunctuation(text);
        const totalChars = Math.max(1, text.length);
        const duration = Math.max(0, cue.end - cue.start);

        // Only split at internal endings. A final ending already coincides with
        // the end of the cue.
        const splitPositions = analysis.positions
            .filter((pos) => pos < text.length && text.slice(pos).trim().length > 0)
            .sort((a, b) => a - b);

        if (splitPositions.length === 0) {
            return [Object.assign({}, cue, {
                unitIndex: 0,
                unitCount: 1,
                cueStart: cue.start,
                cueEnd: cue.end,
            })];
        }

        const units = [];
        let charStart = 0;
        const boundaries = splitPositions.concat([text.length]);

        boundaries.forEach((charEnd, unitIndex) => {
            const raw = text.slice(charStart, charEnd);
            const leading = raw.length - raw.replace(/^\s+/, '').length;
            const trailing = raw.length - raw.replace(/\s+$/, '').length;
            const cleaned = raw.trim();
            if (!cleaned) {
                charStart = charEnd;
                return;
            }

            const realStart = charStart + leading;
            const realEnd = charEnd - trailing;
            const start = cue.start + (realStart / totalChars) * duration;
            const end = cue.start + (realEnd / totalChars) * duration;

            units.push(Object.assign({}, cue, {
                start,
                end,
                mid: Number(((start + end) / 2).toFixed(3)),
                text: cleaned,
                index: cue.index,
                unitIndex: units.length,
                unitCount: boundaries.length,
                cueStart: cue.start,
                cueEnd: cue.end,
            }));
            charStart = charEnd;
        });

        // Guarantee exact original outer timing.
        if (units.length) {
            units[0].start = cue.start;
            units[units.length - 1].end = cue.end;
            units[0].mid = Number(((units[0].start + units[0].end) / 2).toFixed(3));
            units[units.length - 1].mid = Number(((units[units.length - 1].start + units[units.length - 1].end) / 2).toFixed(3));
            units.forEach((u) => { u.unitCount = units.length; });
        }

        return units;
    }

    /**
     * Group cues into paragraphs.
     *
     * @param {Array<{index:number,start:number,end:number,mid:number,text:string}>} cues
     * @param {Object} [options] overrides for DEFAULTS; `sentenceEndCues` may be
     *        a Set/array/iterable of cue.index values, or a predicate.
     * @returns {{paragraphs: Array<Array<Object>>, meta: Object}}
     */
    function groupCues(cues, options) {
        if (!Array.isArray(cues)) {
            throw new TypeError('groupCues expects an array of cues');
        }

        const opts = Object.assign({}, DEFAULTS, options || {});
        if (cues.length === 0) {
            return { paragraphs: [], meta: { options: opts, paragraphInfo: [], sentenceEndCues: [] } };
        }

        const hintPredicate = normalizeHintSource(opts.sentenceEndCues);
        const rows = analyzeCues(cues, opts, hintPredicate);

        // First pass: choose paragraph ranges.
        const ranges = [];
        let start = 0;
        while (start < rows.length) {
            const chosen = chooseParagraphEnd(rows, start, opts);
            const end = Math.min(chosen.end, rows.length - 1);
            ranges.push({
                start,
                end,
                trace: chosen.trace,
            });
            start = end + 1;
        }

        // Second pass: fold away accidental micro-paragraphs. The scorer is
        // already reluctant to create them, but the final cue (or a forced
        // speaker turn) can still leave a one-word paragraph such as "Cheers.".
        // Only merge when there is no speaker change and no large pause at the
        // boundary, and only while the combined paragraph stays under the hard
        // caps. This keeps forced turn/silence breaks intact.
        for (let i = opts.mergeTinyParagraphs ? ranges.length - 1 : -1; i >= 0; i--) {
            const range = ranges[i];
            const stats = paragraphTextStats(rows, range.start, range.end);
            const tiny =
                stats.duration < 6 ||
                (stats.cueCount === 1 && stats.duration < 9);
            if (!tiny) continue;

            // Merge backwards by preference (the tiny closing line usually
            // belongs to the preceding paragraph).
            let target = i - 1;
            if (target < 0) target = i + 1 < ranges.length ? i + 1 : -1;
            if (target < 0) continue;

            const first = target < i ? target : i;
            const second = target < i ? i : target;
            const a = ranges[first];
            const b = ranges[second];
            const combined = paragraphTextStats(rows, a.start, b.end);
            const boundaryRow = rows[a.end + 1];
            const gap = boundaryRow
                ? Math.max(0, boundaryRow.cue.start - rows[a.end].cue.end)
                : 0;

            if (boundaryRow && boundaryRow.speakerChange) continue;
            if (gap >= opts.pauseThreshold) continue;
            if (combined.cueCount > opts.maxCues ||
                combined.duration > opts.maxDuration ||
                combined.chars > opts.maxChars) continue;

            ranges.splice(first, 2, { start: a.start, end: b.end, trace: undefined });
            i = first + 1; // after the loop's i--, re-check the merged paragraph
        }

        // Third pass: materialize the public output.
        const paragraphs = [];
        const paragraphInfo = [];

        ranges.forEach((range) => {
            const stats = paragraphTextStats(rows, range.start, range.end);
            const info = {
                startIndex: rows[range.start].cue.index,
                endIndex: rows[range.end].cue.index,
                start: rows[range.start].cue.start,
                end: rows[range.end].cue.end,
                duration: stats.duration,
                chars: stats.chars,
                cueCount: stats.cueCount,
                sentenceCount: stats.sentenceCount,
                endsSentence: rows[range.end].endsSentence,
                breakReason: describeBreak(rows, range.end, opts),
            };
            if (opts.debug && range.trace) info.candidateTrace = range.trace;
            paragraphs.push(rows.slice(range.start, range.end + 1).map((row) => row.cue));
            paragraphInfo.push(info);
        });

        return {
            paragraphs,
            meta: {
                options: opts,
                paragraphInfo,
                sentenceEndCues: rows.filter((row) => row.endsSentence).map((row) => row.cue.index),
            },
        };
    }

    return {
        DEFAULTS,
        groupCues,
        splitCueIntoSentenceUnits,
        analyzeSentencePunctuation,
    };
});
