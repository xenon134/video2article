#!/usr/bin/env node
/*
 * tools/grouping_test.mjs
 * ---------------------------------------------------------------------------
 * Node harness for tools/grouping.js.
 *
 * Reads:
 *   - test.srt                         (auto-caption-like, sparse punctuation)
 *   - cache/M7lc1UVf-VE.en.srt         (manual subtitles, ~50% terminal cues)
 *
 * For each fixture it prints:
 *   - the old fixed 7-cue grouping baseline,
 *   - the new grouper without hints,
 *   - the new grouper with heuristic sentence hints (a stand-in for an LM),
 *   - duration / char / cue / sentence stats,
 *   - how many paragraph breaks land mid-sentence,
 *   - five sample paragraphs.
 *
 * Usage:
 *   node tools/grouping_test.mjs
 *   node tools/grouping_test.mjs path/to/auto.srt path/to/manual.srt
 *
 * The module is a UMD-style plain script; createRequire lets this .mjs file
 * load it without adding package.json / build tooling.
 * ---------------------------------------------------------------------------
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('./grouping.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_FIXTURES = [
    path.join(ROOT, 'test.srt'),
    path.join(ROOT, 'cache', 'M7lc1UVf-VE.en.srt'),
];

/********************************************************************
 * SRT PARSING (mirrors index.html's parseSrtContent semantics)
 ********************************************************************/
function parseSrtTimeToSeconds(timeString) {
    const clean = String(timeString || '').trim().replace(',', '.');
    const parts = clean.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
}

function parseSrt(rawSrt) {
    const normalized = String(rawSrt || '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    const blocks = normalized.trim().split(/\n\s*\n/);
    const timecodeRegex = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{2}:\d{2}[,.]\d{1,3})/;
    const cues = [];

    for (const block of blocks) {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
        const timeLineIndex = lines.findIndex((line) => timecodeRegex.test(line));
        if (timeLineIndex === -1) continue;

        const match = lines[timeLineIndex].match(timecodeRegex);
        if (!match) continue;

        const start = parseSrtTimeToSeconds(match[1]);
        const end = Math.max(start, parseSrtTimeToSeconds(match[2]));
        const text = lines.slice(timeLineIndex + 1)
            .join(' ')
            .replace(/<[^>]*>/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!text) continue;

        cues.push({
            index: cues.length,
            start,
            end,
            mid: Number(((start + end) / 2).toFixed(3)),
            text,
        });
    }

    return cues;
}

/********************************************************************
 * HEURISTIC HINTS (stand-in for an LM sentence-end classifier)
 *
 * We deliberately keep this conservative. A real LM would mark sentence
 * boundaries at cue ends even where the auto-caption text has no punctuation.
 * Without one, we only add hints where the next cue clearly starts a new
 * sentence and the current cue does not end in a function word.
 ********************************************************************/
const CONTINUATION_WORDS = new Set(`
    a an the and or but if because so to of in on at for with from by as than
    that which who whom whose is are was were be been being am do does did have
    has had will would can could shall should may might must not into onto over
    under after before while when where why how this these those my your his her
    its our their me him them us there here about like just very really also
    then now some any all more most much many
`.trim().split(/\s+/));

const SENTENCE_STARTER_RE = /^(And|But|So|Now|Then|Today|Okay|Well|The|This|That|I|We|You|It|He|She|They|There|Here|What|Why|How|If|When|Because|Also|Another|Finally|First|Next|One|My|Our|Your|His|Her|Their|After|Before|As|At|In|On|For|With|From|By|To|Let|Do|Does|Did|Can|Could|Would|Should|Will|Are|Is|Was|Were|Have|Has|Had)\b/;

function stripSpeakerPrefix(text) {
    return String(text || '')
        .replace(/^\s*>>\s*/, '')
        .replace(/^\s*[A-Z][A-Z0-9 .'&()\/-]{1,40}:\s+/, '')
        .trim();
}

function lastWord(text) {
    const match = String(text || '').match(/[A-Za-z0-9'’]+(?=[^A-Za-z0-9'’]*$)/);
    return match ? match[0].toLowerCase() : '';
}

function deriveHeuristicHints(cues) {
    const hints = new Set();

    for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        const punctuation = G.analyzeSentencePunctuation(cue.text);

        if (punctuation.endsSentence) {
            hints.add(cue.index);
            continue;
        }

        const next = cues[i + 1];
        if (!next) continue;

        const gap = next.start - cue.end;
        const text = cue.text.trim();
        const nextFirst = stripSpeakerPrefix(next.text).split(/\s+/)[0] || '';

        if (gap >= 1.2) {
            hints.add(cue.index);
            continue;
        }

        const looksLikeNewSentence =
            !/^[a-z]/.test(nextFirst) &&
            SENTENCE_STARTER_RE.test(nextFirst) &&
            !CONTINUATION_WORDS.has(lastWord(text)) &&
            !/[,;:—–-]\s*$/.test(text);

        if (looksLikeNewSentence) hints.add(cue.index);
    }

    return hints;
}

/********************************************************************
 * BASELINE (the current index.html rule)
 ********************************************************************/
function baselineGroup(cues) {
    const paragraphs = [];
    let current = [];

    for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        current.push(cue);
        const next = cues[i + 1];
        const endsWithTerminal = /[.?!]["'”’)]?$/.test(cue.text);
        const gap = next ? next.start - cue.end : 0;

        const shouldBreak =
            (endsWithTerminal && (current.length >= 3 || gap > 1.5)) ||
            current.length >= 7 ||
            !next;

        if (shouldBreak) {
            paragraphs.push(current);
            current = [];
        }
    }

    return paragraphs;
}

/********************************************************************
 * STATS / FORMATTING
 ********************************************************************/
function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function statsFor(paragraphs, info, isSentenceEnd) {
    const durations = info.map((p) => p.duration);
    const chars = info.map((p) => p.chars);
    const cues = info.map((p) => p.cueCount);
    const sentences = info.map((p) => p.sentenceCount);

    const breaks = Math.max(0, paragraphs.length - 1);
    let midSentence = 0;
    let speakerForced = 0;

    for (let i = 0; i < breaks; i++) {
        const lastCue = paragraphs[i][paragraphs[i].length - 1];
        if (!isSentenceEnd(lastCue)) midSentence++;
        if (info[i].breakReason === 'speaker') speakerForced++;
    }

    const summarize = (values) => ({
        min: Math.min(...values),
        median: median(values),
        max: Math.max(...values),
        mean: values.reduce((a, b) => a + b, 0) / values.length,
    });

    return {
        count: paragraphs.length,
        duration: summarize(durations),
        chars: summarize(chars),
        cues: summarize(cues),
        sentences: summarize(sentences),
        breaks,
        midSentence,
        speakerForced,
    };
}

function formatSeconds(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function num(value, digits = 1) {
    return Number(value).toFixed(digits);
}

function printStats(label, stats) {
    const midPct = stats.breaks
        ? ((stats.midSentence / stats.breaks) * 100).toFixed(1)
        : '0.0';

    console.log(`  ${label}`);
    console.log(`    paragraphs : ${stats.count}`);
    console.log(`    duration   : min ${num(stats.duration.min)}s | median ${num(stats.duration.median)}s | mean ${num(stats.duration.mean)}s | max ${num(stats.duration.max)}s`);
    console.log(`    chars      : min ${num(stats.chars.min, 0)} | median ${num(stats.chars.median, 0)} | max ${num(stats.chars.max, 0)}`);
    console.log(`    cues       : min ${num(stats.cues.min, 0)} | median ${num(stats.cues.median, 0)} | max ${num(stats.cues.max, 0)}`);
    console.log(`    sentences  : min ${num(stats.sentences.min, 0)} | median ${num(stats.sentences.median, 0)} | max ${num(stats.sentences.max, 0)}`);
    console.log(`    breaks     : ${stats.breaks} | sentence-aligned ${stats.breaks - stats.midSentence} (${(100 - Number(midPct)).toFixed(1)}%) | mid-sentence ${stats.midSentence} (${midPct}%) | speaker-forced ${stats.speakerForced}`);
}

function printSamples(paragraphs, info, count = 5) {
    if (!paragraphs.length) return;
    const wanted = Math.min(count, paragraphs.length);
    const indices = [];
    for (let i = 0; i < wanted; i++) {
        indices.push(Math.round((i * (paragraphs.length - 1)) / Math.max(1, wanted - 1)));
    }

    console.log(`\n  ${wanted} sample paragraphs:`);
    for (const index of indices) {
        const para = paragraphs[index];
        const p = info[index];
        const text = para.map((cue) => cue.text).join(' ');
        const clipped = text.length > 420 ? `${text.slice(0, 417)}...` : text;
        console.log(`\n    [${index + 1}/${paragraphs.length}] ${formatSeconds(p.start)}-${formatSeconds(p.end)}  ${num(p.duration)}s, ${p.cueCount} cues, ${p.sentenceCount} sentence endings, ${p.chars} chars, break=${p.breakReason}`);
        console.log(`    ${clipped}`);
    }
}

function makeSentenceEndTester(hints) {
    const hintSet = hints instanceof Set ? hints : new Set(hints || []);
    return (cue) => {
        return G.analyzeSentencePunctuation(cue.text).endsSentence || hintSet.has(cue.index);
    };
}

function analyzeFixture(filePath) {
    const cues = parseSrt(fs.readFileSync(filePath, 'utf8'));
    const hints = deriveHeuristicHints(cues);
    const totalDuration = cues.length ? cues[cues.length - 1].end - cues[0].start : 0;
    const punctuated = cues.filter((cue) => G.analyzeSentencePunctuation(cue.text).endsSentence);
    const addedHints = [...hints].filter((index) => !G.analyzeSentencePunctuation(cues[index].text).endsSentence);

    console.log(`\n${'='.repeat(78)}`);
    console.log(`FIXTURE: ${path.relative(ROOT, filePath)}`);
    console.log(`${'='.repeat(78)}`);
    console.log(`  cues: ${cues.length} | transcript duration: ${num(totalDuration)}s | cues ending in punctuation: ${punctuated.length} (${num((punctuated.length / cues.length) * 100)}%)`);
    console.log(`  heuristic hints: ${hints.size} total (${addedHints.length} added beyond punctuation)`);
    if (addedHints.length === 0) {
        console.log('  (hints are redundant here: punctuation already marks every cue-end sentence boundary)');
    }

    // ------------------------------------------------------------------
    // Baseline
    // ------------------------------------------------------------------
    const baseParagraphs = baselineGroup(cues);
    const baseInfo = baseParagraphs.map((para) => {
        const first = para[0];
        const last = para[para.length - 1];
        return {
            start: first.start,
            end: last.end,
            duration: last.end - first.start,
            chars: para.reduce((sum, cue) => sum + cue.text.length, 0) + Math.max(0, para.length - 1),
            cueCount: para.length,
            sentenceCount: para.reduce((sum, cue) => sum + G.analyzeSentencePunctuation(cue.text).count, 0),
            endsSentence: G.analyzeSentencePunctuation(last.text).endsSentence,
            breakReason: 'baseline',
        };
    });
    const baseTester = makeSentenceEndTester(new Set());
    const baseStats = statsFor(baseParagraphs, baseInfo, baseTester);
    printStats('OLD RULE (fixed 7 cues + early punctuation break)', baseStats);

    // ------------------------------------------------------------------
    // New grouper, no hints
    // ------------------------------------------------------------------
    const noHint = G.groupCues(cues, {});
    const noHintTester = makeSentenceEndTester(new Set());
    const noHintStats = statsFor(noHint.paragraphs, noHint.meta.paragraphInfo, noHintTester);
    printStats('\nNEW GROUPER — punctuation only (no hints)', noHintStats);

    // ------------------------------------------------------------------
    // New grouper, heuristic hints
    // ------------------------------------------------------------------
    const hinted = G.groupCues(cues, { sentenceEndCues: hints });
    const hintTester = makeSentenceEndTester(hints);
    const hintStats = statsFor(hinted.paragraphs, hinted.meta.paragraphInfo, hintTester);
    printStats('\nNEW GROUPER — with heuristic sentence hints', hintStats);

    // ------------------------------------------------------------------
    // Samples (use the hinted run so the printed sentence counts include
    // the hint bookkeeping; the no-hint text is otherwise identical).
    // ------------------------------------------------------------------
    printSamples(hinted.paragraphs, hinted.meta.paragraphInfo, 5);

    return {
        cues,
        hints,
        baseline: { paragraphs: baseParagraphs, info: baseInfo, stats: baseStats },
        noHint: { paragraphs: noHint.paragraphs, info: noHint.meta.paragraphInfo, stats: noHintStats },
        hinted: { paragraphs: hinted.paragraphs, info: hinted.meta.paragraphInfo, stats: hintStats },
    };
}

function main() {
    const args = process.argv.slice(2);
    const explicit = args.map((p) => path.resolve(p));
    let fixtures = explicit.length ? explicit : DEFAULT_FIXTURES;
    const missing = fixtures.filter((file) => !fs.existsSync(file));

    if (missing.length) {
        for (const file of missing) {
            console.error(`Missing fixture: ${file}`);
        }
        if (explicit.length) {
            console.error('\nPass existing SRT paths, for example:');
            console.error('  node tools/grouping_test.mjs test.srt /path/to/M7lc1UVf-VE.en.srt');
            process.exitCode = 1;
            return;
        }

        // The manual fixture lives under cache/, which is gitignored. It is
        // useful but optional: still run the auto-caption fixture if present.
        fixtures = fixtures.filter((file) => fs.existsSync(file));
        if (!fixtures.length) {
            console.error('\nNo fixtures found. Pass explicit SRT paths.');
            process.exitCode = 1;
            return;
        }
        console.error('\nContinuing with the fixtures that exist. The manual-subtitle fixture is gitignored under cache/;');
        console.error('pass an explicit path if yours lives elsewhere:');
        console.error('  node tools/grouping_test.mjs test.srt /path/to/M7lc1UVf-VE.en.srt\n');
    }

    const results = fixtures.map(analyzeFixture);

    console.log(`\n${'='.repeat(78)}`);
    console.log('BEFORE / AFTER SUMMARY');
    console.log(`${'='.repeat(78)}`);
    console.log('fixture'.padEnd(30), 'old'.padStart(6), 'new'.padStart(6), 'hinted'.padStart(8), 'old mid'.padStart(9), 'new mid'.padStart(9));
    fixtures.forEach((file, i) => {
        const r = results[i];
        console.log(
            path.relative(ROOT, file).padEnd(30),
            String(r.baseline.stats.count).padStart(6),
            String(r.noHint.stats.count).padStart(6),
            String(r.hinted.stats.count).padStart(8),
            `${r.baseline.stats.midSentence}`.padStart(9),
            `${r.noHint.stats.midSentence}`.padStart(9)
        );
    });

    console.log('\nNote: without an LM, punctuation-only grouping cannot know where');
    console.log('sentences end in auto-caption text; those mid-sentence breaks are the');
    console.log('fallback cuts. With hints, the same algorithm aligns more breaks.');
}

main();
