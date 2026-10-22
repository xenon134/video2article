#!/usr/bin/env node
/*
 * tools/grouping_edge_test.mjs
 * Tiny dependency-free synthetic test suite for tools/grouping.js.
 *
 * Run: node tools/grouping_edge_test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('./grouping.js');

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`ok ${passed} - ${name}`);
    } catch (error) {
        console.error(`not ok - ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

function makeCues(entries, step = 2) {
    // entries may be strings (uniform step) or [text, start, end] tuples.
    return entries.map((entry, index) => {
        if (Array.isArray(entry)) {
            const [text, start, end] = entry;
            return { index, start, end, mid: (start + end) / 2, text };
        }
        const start = index * step;
        const end = start + step - 0.2;
        return { index, start, end, mid: (start + end) / 2, text: entry };
    });
}

function coverage(result, cueCount) {
    const flat = result.paragraphs.flat();
    assert.equal(flat.length, cueCount);
    flat.forEach((cue, i) => assert.equal(cue.index, i, 'cues stay in original order'));
}

test('empty input', () => {
    const result = G.groupCues([]);
    assert.deepEqual(result.paragraphs, []);
    assert.deepEqual(result.meta.paragraphInfo, []);
});

test('punctuation analysis handles abbreviations, decimals, ellipses, annotations', () => {
    const cases = [
        ['Dr. Smith left.', 1, true],
        ['Mr. Smith left.', 1, true],
        ['U.S. It is big.', 2, true],
        ['Acme Inc. We win.', 2, true],
        ['Acme Inc. announced it.', 1, true],
        ['3.14 is pi.', 1, true],
        ['Wait... what?', 1, true],
        ['Hello...', 1, true],
        ['[? inaudible ?] This is fine.', 1, true],
        ['e.g. this is fine', 0, false],
    ];

    for (const [text, count, ends] of cases) {
        const result = G.analyzeSentencePunctuation(text);
        assert.equal(result.count, count, `sentence count for ${JSON.stringify(text)}`);
        assert.equal(result.endsSentence, ends, `endsSentence for ${JSON.stringify(text)}`);
    }
});

test('splitCueIntoSentenceUnits preserves cue index and outer timing', () => {
    const cue = { index: 9, start: 10, end: 16, mid: 13, text: 'Hello there. How are you? Fine.' };
    const units = G.splitCueIntoSentenceUnits(cue);

    assert.equal(units.length, 3);
    assert.deepEqual(units.map((u) => u.text), ['Hello there.', 'How are you?', 'Fine.']);
    assert.equal(units[0].index, cue.index);
    assert.equal(units[0].start, cue.start);
    assert.equal(units[units.length - 1].end, cue.end);
    assert.equal(units[0].cueStart, cue.start);
    assert.equal(units[0].cueEnd, cue.end);

    for (let i = 1; i < units.length; i++) {
        assert.ok(units[i].start >= units[i - 1].start, 'unit starts are monotonic');
        assert.ok(units[i].end >= units[i].start, 'unit end >= start');
    }
});

test('speaker labels force a paragraph before the new speaker', () => {
    const cues = makeCues([
        'ALICE: One.',
        'Two.',
        'BOB: Three.',
        'Four.',
    ]);
    const result = G.groupCues(cues, { minDuration: 9 });

    assert.equal(result.paragraphs.length, 2);
    assert.equal(result.paragraphs[0].at(-1).index, 1);
    assert.equal(result.paragraphs[1][0].index, 2);
    assert.equal(result.meta.paragraphInfo[0].breakReason, 'speaker');
    coverage(result, cues.length);
});

test('repeating the same speaker label does not force a break', () => {
    const cues = makeCues([
        'ALICE: One.',
        'ALICE: Two.',
        'ALICE: Three.',
    ]);
    const result = G.groupCues(cues);
    assert.equal(result.paragraphs.length, 1);
    assert.notEqual(result.meta.paragraphInfo[0].breakReason, 'speaker');
});

test('auto-caption >> marker forces a turn break', () => {
    const cues = makeCues([
        'Plain line.',
        '>> New speaker.',
        '>> Still the same turn.',
    ]);
    const result = G.groupCues(cues, { minDuration: 9 });
    const speakerBreaks = result.meta.paragraphInfo.filter((p) => p.breakReason === 'speaker');
    assert.equal(speakerBreaks.length, 1);
    assert.equal(speakerBreaks[0].endIndex, 0);
});

test('a large pause at a sentence boundary is a strong break', () => {
    const cues = makeCues([
        ['First sentence.', 0, 4],
        ['Second sentence.', 4, 8],
        ['Third sentence.', 10.5, 14.5],
        ['Fourth sentence.', 14.5, 18.5],
    ]);
    const result = G.groupCues(cues);
    const pauseBreak = result.meta.paragraphInfo.find((p) => p.breakReason === 'sentence-pause');
    assert.ok(pauseBreak, 'expected a sentence-pause boundary');
    assert.equal(pauseBreak.endIndex, 1);
});

test('sentence hints are counted and can create a boundary without punctuation', () => {
    const cues = makeCues([
        'alpha beta gamma',
        'delta epsilon zeta',
        'eta theta iota',
        'kappa lambda mu',
    ], 5);
    const result = G.groupCues(cues, { sentenceEndCues: [1] });

    assert.ok(result.meta.sentenceEndCues.includes(1));
    assert.equal(result.meta.paragraphInfo[0].sentenceCount, 1);
    assert.equal(result.paragraphs[0].at(-1).index, 1);
});

test('hint predicate is supported', () => {
    const cues = makeCues([
        'alpha beta gamma',
        'delta epsilon zeta',
        'eta theta iota',
    ], 3);
    const result = G.groupCues(cues, {
        sentenceEndCues: (cue) => cue.index === 0,
    });
    assert.ok(result.meta.sentenceEndCues.includes(0));
});

test('unpunctuated fallback respects duration/cue/char caps', () => {
    const cues = makeCues(Array.from({ length: 30 }, () => 'this is unpunctuated caption text'), 2.5);
    const result = G.groupCues(cues);

    assert.ok(result.paragraphs.length > 1);
    for (const p of result.meta.paragraphInfo) {
        assert.ok(p.duration <= 40.001, `duration cap: ${p.duration}`);
        assert.ok(p.cueCount <= 14, `cue cap: ${p.cueCount}`);
        assert.ok(p.chars <= 450, `char cap: ${p.chars}`);
    }
    coverage(result, cues.length);
});

test('tiny cues do not produce tiny non-final paragraphs', () => {
    const cues = makeCues(Array.from({ length: 24 }, (_, i) => `Tiny sentence number ${i}.`), 0.7);
    const result = G.groupCues(cues);
    const nonFinal = result.meta.paragraphInfo.slice(0, -1);
    for (const p of nonFinal) {
        assert.ok(p.duration >= 8, `non-final duration ${p.duration} should be >= 8s`);
    }
});

test('a single long multi-sentence cue is not split by groupCues', () => {
    const cues = makeCues([
        ['First sentence. Second sentence? Third!', 0, 12],
        ['A normal follow-up sentence.', 12, 15],
    ]);
    const result = G.groupCues(cues);
    assert.ok(result.paragraphs.some((p) => p.some((cue) => cue.index === 0)));
    assert.equal(result.paragraphs.flat().filter((cue) => cue.index === 0).length, 1);
});

test('does not mutate cues and preserves object identity', () => {
    const cues = makeCues(['One sentence.', 'Two sentence.', 'Three sentence.']).map((cue) => Object.freeze(cue));
    const result = G.groupCues(cues);
    const flat = result.paragraphs.flat();
    assert.equal(flat.length, cues.length);
    flat.forEach((cue, i) => assert.equal(cue, cues[i], 'paragraphs keep original cue references'));
});

if (!process.exitCode) {
    console.log(`\n${passed} synthetic tests passed`);
}
