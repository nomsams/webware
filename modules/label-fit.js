// Fits a label's text into the space beside its QR code: wraps on WORDS (never mid-word unless a single
// word cannot fit at all), balances the lines, and shrinks the type until everything fits — instead of
// letting a long name run off the left edge (the labels are right-aligned, so an over-long line spilled
// leftwards under the QR code and lost the START of the name).
//
// STATUS: wired in — index.html's label preview (and so the print / HTML-export copies of it) builds each
// label's text through fitLabelText() (bridged as window.fitLabelText), measuring with a canvas. Pure and
// dependency-injected like the other modules: no DOM here, the caller supplies the box size and a
// measure(text, {px, weight, letterSpacing}) -> width function, so it can be tested with a fake ruler.
//
// Units: the box (width/height) is in CSS px; type sizes are in pt (CSS pt, 96/72 px each); a block's
// line-height is 1.2 x its font size, as in the label CSS (.label-text div { line-height: 1.2 }).
//
// What it does, in order:
//   1. Starting at maxScale (the user's "Text size" slider), lays every block out at base size x scale,
//      wrapping the wrappable ones on spaces (or, for the item-number line, between the numbers).
//   2. If the result is too tall, or a single word is wider than the box, lowers the scale a little and
//      tries again — so the LARGEST size that fits wins, and it never exceeds the user's own choice.
//      Each block has a floor (minPt) below which it stops shrinking, to stay legible on a small label.
//   3. Only when everything is already at its floor and a word is STILL too wide does it break that word,
//      preferring - / _ . , : ; and then plain characters (no hyphen is inserted: these are identifiers).
//   4. Only if it is STILL too tall does it drop trailing lines of the name (then the manufacturer), ending
//      the last kept line with "…", and reports truncated: true. Nothing else is ever lost.

export const PX_PER_PT = 96 / 72;
export const PX_PER_MM = 96 / 25.4;
const LINE_HEIGHT = 1.2;

// basePt = the size at scale 1 (matches the .l-* CSS classes); minPt = the floor; marginTopMm as in the CSS.
export const LABEL_TEXT_STYLES = Object.freeze({
  nums: Object.freeze({ basePt: 14, minPt: 8, weight: 900, letterSpacing: -0.3, marginTopMm: 0.5, wrap: true }),
  name: Object.freeze({ basePt: 11, minPt: 6, weight: 700, letterSpacing: 0, marginTopMm: 1.5, wrap: true }),
  mfr: Object.freeze({ basePt: 8, minPt: 5.5, weight: 600, letterSpacing: 0, marginTopMm: 0.5, wrap: true }),
  btk: Object.freeze({ basePt: 6, minPt: 5, weight: 600, letterSpacing: 0.3, marginTopMm: 0, wrap: false }),
});

const round1 = (n) => Math.round(n * 10) / 10;

// Greedy fill: as many tokens per line as fit.
function greedyWrap(tokens, joiner, maxWidth, measure) {
  const lines = [];
  let line = '';
  for (const token of tokens) {
    const candidate = line ? line + joiner + token : token;
    if (line && measure(candidate) > maxWidth) {
      lines.push(line);
      line = token;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Greedy wrapping leaves a stub on the last line ("… VALVE ASSEMBLY" / "KIT"). Keeping the line COUNT the
// greedy fill needs, this finds the narrowest width that still needs no more lines, so the lines come out
// even — like CSS text-wrap: balance. Never narrower than the widest single token.
function balancedWrap(tokens, joiner, maxWidth, measure) {
  const greedy = greedyWrap(tokens, joiner, maxWidth, measure);
  if (greedy.length <= 1) return greedy;
  let lo = Math.max(...tokens.map((t) => measure(t)));
  let hi = maxWidth;
  if (lo >= hi) return greedy;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (greedyWrap(tokens, joiner, mid, measure).length <= greedy.length) hi = mid;
    else lo = mid;
  }
  return greedyWrap(tokens, joiner, hi, measure);
}

// Last resort for one token wider than the whole box: cut it into pieces that each fit, at a natural
// separator when that still leaves a reasonably full line, otherwise between characters.
export function breakToken(token, maxWidth, measure) {
  if (measure(token) <= maxWidth) return [token];
  const pieces = [];
  let rest = token;
  while (rest && measure(rest) > maxWidth) {
    let cut = rest.length;
    while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--;
    const fitting = rest.slice(0, cut);
    const m = fitting.match(/^(.*[-/_.,:;])[^-/_.,:;]*$/);
    const len = m && m[1].length >= Math.ceil(cut * 0.4) ? m[1].length : cut;
    pieces.push(rest.slice(0, len));
    rest = rest.slice(len);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// Splits a block into its wrappable tokens: `parts` (already-separate atoms such as item numbers, joined
// with `joiner`) when given, otherwise the words of `text`.
function tokensOf(block) {
  if (Array.isArray(block.parts)) {
    const parts = block.parts.map((p) => String(p ?? '').trim()).filter(Boolean);
    return { tokens: parts, joiner: block.joiner ?? ' · ' };
  }
  const words = String(block.text ?? '').trim().split(/\s+/).filter(Boolean);
  return { tokens: words, joiner: ' ' };
}

function layoutBlocks(blocks, scale, box, measure, styles, breakWords) {
  const laid = [];
  let anyOverflow = false;
  for (const block of blocks) {
    const style = styles[block.key];
    if (!style) throw new Error(`fitLabelText: unknown block key "${block.key}"`);
    const { tokens, joiner } = tokensOf(block);
    if (!tokens.length) continue;
    const pt = Math.max(style.minPt, round1(style.basePt * scale));
    const px = pt * PX_PER_PT;
    const measureAt = (t) => measure(t, { px, weight: style.weight, letterSpacing: style.letterSpacing });
    const wrappable = block.wrap ?? style.wrap;
    let lines;
    if (wrappable) {
      const usable = breakWords ? tokens.flatMap((t) => breakToken(t, box.width, measureAt)) : tokens;
      lines = balancedWrap(usable, joiner, box.width, measureAt);
    } else {
      lines = [tokens.join(joiner)];
    }
    if (lines.some((l) => measureAt(l) > box.width)) anyOverflow = true;
    laid.push({
      key: block.key, pt, lines, weight: style.weight, letterSpacing: style.letterSpacing,
      marginTop: style.marginTopMm * PX_PER_MM, measureAt, px,
    });
  }
  return { laid, anyOverflow, height: laid.reduce((h, b) => h + b.marginTop + b.lines.length * b.px * LINE_HEIGHT, 0) };
}

// Ends the last line with an ellipsis, trimming it (on a character boundary — it is already the tail of a
// wrapped line) until the whole thing fits.
function withEllipsis(line, maxWidth, measureAt) {
  let out = line;
  while (out.length > 1 && measureAt(out + '…') > maxWidth) out = out.slice(0, -1);
  return out.replace(/[\s·,;:-]+$/, '') + '…';
}

/**
 * @param {{key:'nums'|'name'|'mfr'|'btk', text?:string, parts?:string[], joiner?:string, wrap?:boolean}[]} blocks
 *   in top-to-bottom order; blocks with no text are dropped.
 * @param {{width:number, height:number, measure:(text:string, o:{px:number, weight:number, letterSpacing:number})=>number,
 *          maxScale?:number, minScale?:number, safety?:number, styles?:object}} opts
 * @returns {{scale:number, truncated:boolean, height:number,
 *            blocks:{key:string, pt:number, lines:string[], weight:number, letterSpacing:number, marginTop:number}[]}}
 */
export function fitLabelText(blocks, { width, height, measure, maxScale = 1, minScale = 0.2, safety = 0.97, styles = LABEL_TEXT_STYLES } = {}) {
  if (!(width > 0) || !(height > 0) || typeof measure !== 'function') throw new Error('fitLabelText: width, height and measure are required');
  // A few percent of slack: the text is measured on a canvas but drawn by the browser's layout / the print
  // engine, whose advance widths can differ slightly.
  const box = { width: width * safety, height };
  const pack = (laid, scale, truncated, used) => ({
    scale, truncated, height: used,
    blocks: laid.map(({ key, pt, lines, weight, letterSpacing, marginTop }) => ({ key, pt, lines, weight, letterSpacing, marginTop })),
  });

  // Largest scale that fits, in 2% steps down from the user's own choice.
  let floorScale = maxScale;
  for (let i = 0; ; i++) {
    const scale = Math.round((maxScale - i * 0.02) * 100) / 100;
    if (scale < minScale) break;
    floorScale = scale;
    const layout = layoutBlocks(blocks, scale, box, measure, styles, false);
    if (!layout.anyOverflow && layout.height <= box.height) return pack(layout.laid, scale, false, layout.height);
    // every block already at its own floor: shrinking further would change nothing
    if (layout.laid.every((b) => b.pt <= styles[b.key].minPt)) break;
  }

  // Floor reached. Break a too-wide word if that is what is in the way…
  const layout = layoutBlocks(blocks, floorScale, box, measure, styles, true);
  if (layout.height <= box.height) return pack(layout.laid, floorScale, false, layout.height);

  // …and if it is still too tall, drop trailing lines of the name, then the manufacturer.
  const laid = layout.laid;
  const total = () => laid.reduce((h, b) => h + (b.lines.length ? b.marginTop + b.lines.length * b.px * LINE_HEIGHT : 0), 0);
  let truncated = false;
  for (const key of ['name', 'mfr']) {
    const block = laid.find((b) => b.key === key);
    if (!block) continue;
    while (total() > box.height && block.lines.length > 1) {
      block.lines.pop();
      block.lines[block.lines.length - 1] = withEllipsis(block.lines[block.lines.length - 1], box.width, block.measureAt);
      truncated = true;
    }
    if (total() <= box.height) break;
  }
  if (total() > box.height) {
    // one line of name is all that's left to give up — keep it (ellipsised if needed) and drop the manufacturer
    const mfr = laid.find((b) => b.key === 'mfr');
    if (mfr && mfr.lines.length) { mfr.lines = []; truncated = true; }
  }
  return pack(laid.filter((b) => b.lines.length), floorScale, truncated, total());
}
