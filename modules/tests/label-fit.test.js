// Run: node --test modules/tests/label-fit.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLabelText, breakToken, LABEL_TEXT_STYLES, PX_PER_PT, PX_PER_MM } from '../label-fit.js';

// A deterministic ruler: every character is 0.55 em wide (plus letter-spacing), whatever the character.
const measure = (text, { px, letterSpacing }) => text.length * (px * 0.55 + letterSpacing);

// The default 90x29 mm label: text box beside the QR is about 52 x 26 mm; wide68 leaves about 31 x 25 mm.
const DEFAULT = { width: 52 * PX_PER_MM, height: 26 * PX_PER_MM, measure };
const NARROW = { width: 31 * PX_PER_MM, height: 25 * PX_PER_MM, measure };
const SAFETY = 0.97;

const linesOf = (fit, key) => (fit.blocks.find((b) => b.key === key) || { lines: [] }).lines;
const words = (s) => s.split(/\s+/).filter(Boolean);
const widthOf = (block, line) => measure(line, { px: block.pt * PX_PER_PT, letterSpacing: block.letterSpacing });
const usedHeight = (fit) => fit.blocks.reduce((h, b) => h + b.marginTop + b.lines.length * b.pt * PX_PER_PT * 1.2, 0);

test('a short label is left at its normal sizes, one line each', () => {
  const fit = fitLabelText([
    { key: 'nums', parts: ['955.248B'] }, { key: 'name', text: 'O-RING 102 X 4' }, { key: 'btk', text: 'BTK000002W01' },
  ], DEFAULT);
  assert.equal(fit.scale, 1);
  assert.equal(fit.truncated, false);
  assert.deepEqual(fit.blocks.map((b) => [b.key, b.pt, b.lines.length]), [['nums', 14, 1], ['name', 11, 1], ['btk', 6, 1]]);
});

test('a long name wraps on SPACES — every line is made of whole words, in order, nothing lost', () => {
  const name = 'HYDRAULIC PRESSURE RELIEF VALVE ASSEMBLY COMPLETE WITH SEALS AND SPRING KIT';
  const fit = fitLabelText([{ key: 'name', text: name }, { key: 'btk', text: 'BTK000001W01' }], DEFAULT);
  const lines = linesOf(fit, 'name');
  assert.ok(lines.length > 1, 'wrapped onto several lines');
  assert.deepEqual(words(lines.join(' ')), words(name));
  for (const line of lines) for (const w of words(line)) assert.ok(words(name).includes(w), `"${w}" is a whole word`);
  assert.equal(fit.truncated, false);
});

test('every line fits the box width, and the whole block fits its height', () => {
  const name = 'HYDRAULIC PRESSURE RELIEF VALVE ASSEMBLY COMPLETE WITH SEALS AND SPRING KIT';
  const fit = fitLabelText([{ key: 'nums', parts: ['794.021C', '784501A'] }, { key: 'name', text: name }, { key: 'mfr', text: 'HANY GMBH & CO' }, { key: 'btk', text: 'BTK000001W01' }], DEFAULT);
  for (const b of fit.blocks) for (const line of b.lines) assert.ok(widthOf(b, line) <= DEFAULT.width * SAFETY + 1e-6, `${b.key}: "${line}" is ${widthOf(b, line).toFixed(1)}px`);
  assert.ok(usedHeight(fit) <= DEFAULT.height + 1e-6, `height ${usedHeight(fit).toFixed(1)} <= ${DEFAULT.height.toFixed(1)}`);
});

test('the lines are balanced, not one long line and a stub', () => {
  // "AAAA BBBB CCCC DDDD EEEE": greedy at this width would give 4 words / 1 word.
  const style = LABEL_TEXT_STYLES.name;
  const px = style.basePt * PX_PER_PT;
  const wordW = 4 * px * 0.55;
  const box = { width: (4 * wordW + 3 * (px * 0.55)) / SAFETY + 1, height: 200, measure };
  const fit = fitLabelText([{ key: 'name', text: 'AAAA BBBB CCCC DDDD EEEE' }], box);
  const lines = linesOf(fit, 'name');
  assert.equal(lines.length, 2);
  assert.ok(words(lines[1]).length >= 2, `second line has more than a stub: ${JSON.stringify(lines)}`);
});

test('text never gets larger than the user\'s own size choice', () => {
  const at = (maxScale) => fitLabelText([{ key: 'nums', parts: ['A1'] }, { key: 'name', text: 'Bolt' }, { key: 'btk', text: 'BTK1' }], { ...DEFAULT, maxScale });
  assert.equal(at(1.4).scale, 1.4);
  assert.deepEqual(at(0.8).blocks.map((b) => b.pt), [11.2, 8.8, 5]); // 14x.8, 11x.8, 6x.8 -> the btk floor is 5
  assert.equal(at(0.7).scale, 0.7);
});

test('more text can only make the type smaller or equal, never larger', () => {
  let name = 'PART';
  let previous = Infinity;
  for (let i = 0; i < 16; i++) {
    name += ' EXTRA WORD';
    const fit = fitLabelText([{ key: 'nums', parts: ['794.021C'] }, { key: 'name', text: name }, { key: 'btk', text: 'BTK000001W01' }], DEFAULT);
    assert.ok(fit.scale <= previous + 1e-9, `scale ${fit.scale} after ${previous}`);
    previous = fit.scale;
  }
  assert.ok(previous < 1, 'and by the end it really had to shrink');
});

test('shrinks BEFORE it breaks a word: a long single word is only cut once the type is at its floor', () => {
  const word = 'SUPERLONGSINGLEWORDPARTNAMETHATHASNOSPACESATALL';
  const fit = fitLabelText([{ key: 'name', text: word }], DEFAULT);
  const lines = linesOf(fit, 'name');
  assert.equal(lines.join(''), word, 'no characters lost');
  const name = fit.blocks[0];
  assert.ok(name.pt <= LABEL_TEXT_STYLES.name.minPt + 1e-9 || lines.length === 1, 'either it fit whole at a smaller size, or it is at the floor');
  for (const line of lines) assert.ok(widthOf(name, line) <= DEFAULT.width * SAFETY + 1e-6);
});

// breakToken takes a ruler already bound to one font size: 10px type => 5.5px per character here.
const ruler10 = (t) => measure(t, { px: 10, letterSpacing: 0 });

test('a word that cannot fit even at the floor is broken at separators first, keeping every character', () => {
  const code = 'ABCDEFGHIJ-KLMNOPQRST-UVWXYZ0123-456789ABCD';
  const pieces = breakToken(code, 12 * 5.5, ruler10); // room for 12 characters
  assert.equal(pieces.join(''), code);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.slice(0, -1).every((p) => /-$/.test(p)), `broke after the hyphens: ${JSON.stringify(pieces)}`);
  assert.ok(pieces.every((p) => ruler10(p) <= 12 * 5.5 + 1e-9));
});

test('with no separator to break at, it cuts between characters — and a word that already fits is left alone', () => {
  assert.deepEqual(breakToken('ABCDEFGHIJKLMNOP', 6 * 5.5, ruler10), ['ABCDEF', 'GHIJKL', 'MNOP']);
  assert.deepEqual(breakToken('SHORT', 100 * 5.5, ruler10), ['SHORT']);
});

test('breakToken always makes progress, even into an absurdly narrow width', () => {
  const pieces = breakToken('ABCDEFG', 1, ruler10);
  assert.equal(pieces.join(''), 'ABCDEFG');
  assert.equal(pieces.length, 7);
});

test('item numbers wrap BETWEEN the numbers — the separator is never left dangling at a line edge', () => {
  const fit = fitLabelText([{ key: 'nums', parts: ['794.021C', '784501A', '2261-CS-11', 'D-2728'] }], NARROW);
  const lines = linesOf(fit, 'nums');
  assert.ok(lines.length >= 2);
  assert.deepEqual(lines.join(' · ').split(' · '), ['794.021C', '784501A', '2261-CS-11', 'D-2728']);
  for (const line of lines) assert.doesNotMatch(line, /^·|·$/);
});

test('the BTK line is never wrapped — it shrinks instead', () => {
  const fit = fitLabelText([{ key: 'btk', text: 'BTK000123W01' }], { width: 40, height: 100, measure });
  assert.equal(linesOf(fit, 'btk').length, 1);
});

test('a block can be told to wrap even where its style normally does not (a warehouse address on the btk style)', () => {
  const fit = fitLabelText([{ key: 'nums', text: 'Malmo Best' }, { key: 'btk', text: 'Storgatan 12 Malmo Sweden 211 42', wrap: true }], NARROW);
  assert.ok(linesOf(fit, 'btk').length > 1);
});

test('absurd amounts of text are cut with an ellipsis on the NAME, keeping the numbers and the BTK', () => {
  const name = Array.from({ length: 120 }, (_, i) => `WORD${i}`).join(' ');
  const fit = fitLabelText([{ key: 'nums', parts: ['794.021C'] }, { key: 'name', text: name }, { key: 'mfr', text: 'HANY' }, { key: 'btk', text: 'BTK000001W01' }], NARROW);
  assert.equal(fit.truncated, true);
  const nameLines = linesOf(fit, 'name');
  assert.match(nameLines[nameLines.length - 1], /…$/);
  assert.ok(linesOf(fit, 'nums').length >= 1 && linesOf(fit, 'btk').length === 1, 'the identifiers survive');
  assert.ok(usedHeight(fit) <= NARROW.height + 1e-6, `height ${usedHeight(fit).toFixed(1)} fits ${NARROW.height.toFixed(1)}`);
});

test('blocks with no text are dropped, and an empty label yields no blocks', () => {
  const fit = fitLabelText([{ key: 'nums', parts: [] }, { key: 'name', text: '   ' }, { key: 'btk', text: 'BTK1' }], DEFAULT);
  assert.deepEqual(fit.blocks.map((b) => b.key), ['btk']);
  assert.deepEqual(fitLabelText([{ key: 'name', text: '' }], DEFAULT).blocks, []);
});

test('bad input is refused loudly', () => {
  assert.throws(() => fitLabelText([{ key: 'nope', text: 'x' }], DEFAULT), /unknown block key/);
  assert.throws(() => fitLabelText([{ key: 'name', text: 'x' }], { width: 100, height: 100 }), /required/);
  assert.throws(() => fitLabelText([{ key: 'name', text: 'x' }], { width: 0, height: 100, measure }), /required/);
});

test('property: over random names and boxes, a result that is not truncated always fits, and keeps every word in order', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const vocab = ['O-RING', '102', 'X', '4', 'HYDRAULIC', 'PRESSURE', 'VALVE', 'ASSEMBLY', 'KIT', 'M8', 'SEAL', 'FLANGE', 'A-1234', 'THREADED', 'BRASS', 'ELBOW', '1/2"', 'BSP'];
  for (let round = 0; round < 300; round++) {
    const n = 1 + Math.floor(rnd() * 22);
    const name = Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ');
    const box = { width: (25 + rnd() * 80) * PX_PER_MM, height: (14 + rnd() * 20) * PX_PER_MM, measure };
    const maxScale = [0.7, 1, 1.4][Math.floor(rnd() * 3)];
    const fit = fitLabelText([{ key: 'nums', parts: ['794.021C', '784501A'] }, { key: 'name', text: name }, { key: 'btk', text: 'BTK000001W01' }], { ...box, maxScale });
    assert.ok(fit.scale <= maxScale + 1e-9);
    if (!fit.truncated) {
      assert.ok(usedHeight(fit) <= box.height + 1e-6, `round ${round}: height ${usedHeight(fit).toFixed(1)} > ${box.height.toFixed(1)}`);
      for (const b of fit.blocks) if (b.key !== 'btk') for (const line of b.lines) assert.ok(widthOf(b, line) <= box.width * SAFETY + 1e-6, `round ${round}: ${b.key} "${line}"`);
      // words kept in order (a hard-broken word comes back as pieces, so compare with the spaces removed)
      assert.equal(linesOf(fit, 'name').join('').replace(/\s+/g, ''), name.replace(/\s+/g, ''), `round ${round}`);
    }
  }
});
