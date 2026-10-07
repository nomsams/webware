// Orders the lines of a Pack Order into a sensible WALKING route through the warehouse, and says in
// plain words how to get from one stop to the next. Pure — no DOM, no Supabase — same convention as
// the other modules; index.html's guided "Pick Walk" feeds it the order's lines and shows the result
// one stop at a time.
//
// STATUS: wired in (index.html → ▶ Guided Pack, and 🧭 Sort by route on the Pack Order screen).
//
// The route is a heuristic, not a travelling-salesman solver — a pack order is a handful of lines,
// and a route a person can predict beats a mathematically optimal one they can't follow:
//   1. Zones one after another. With a floor layout (`zoneGrid`: zone -> { col, row }) the next
//      zone is always the nearest one not yet visited (nearest-neighbour from `start`); without
//      one, alphabetical — which is how the zones are lettered on the floor anyway.
//   2. Inside a zone, rack by rack (the Depth digit of the bin code — which rack, or which section of
//      a shelving run). The first rack is walked bin 1 → n, the next n → 1, and so on, a snake, so
//      nobody walks back to the start of every rack.
//   3. Within one bin, bottom shelf first.
//   4. Stops with no usable bin code go LAST, in the order they were given — they need a person to
//      look, so they must not hold the walk up halfway through.
//
// Usage:
//   import { planPickRoute, describeMove } from './modules/pick-route.js';
//   const route = planPickRoute([{ id: 'BTK1', zone: 'A', depth: 1, level: 2, bin: 3, row: 1 },
//                                { id: 'BTK2' }]);              // -> same stops, in walking order
//   describeMove(route[0], route[1]);                           // -> 'Same rack, 2 bins along'

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isLocated = (s) => !!(s && s.zone && num(s.depth) > 0 && num(s.level) > 0);

// Nearest-neighbour over the zones that have a floor position; the rest (and everything, when no
// layout is known) follow alphabetically. Always deterministic — same input, same route.
function orderZones(zones, zoneGrid, start) {
  const alpha = [...zones].sort();
  const placed = alpha.filter((z) => zoneGrid && zoneGrid[z] && Number.isFinite(zoneGrid[z].col) && Number.isFinite(zoneGrid[z].row));
  const rest = alpha.filter((z) => !placed.includes(z));
  const ordered = [];
  let at = start && Number.isFinite(start.col) && Number.isFinite(start.row) ? start : null;
  const left = [...placed];
  while (left.length) {
    // With no start point, begin at the placed zone closest to the top-left corner of the floor.
    const from = at || { col: 0, row: 0 };
    let best = 0;
    let bestDist = Infinity;
    left.forEach((z, i) => {
      const d = Math.abs(zoneGrid[z].col - from.col) + Math.abs(zoneGrid[z].row - from.row);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    const [next] = left.splice(best, 1);
    ordered.push(next);
    at = zoneGrid[next];
  }
  return ordered.concat(rest);
}

/**
 * @param {Array<{id:any, zone?:string, depth?:number, level?:number, bin?:number, row?:number}>} stops
 * @param {{zoneGrid?: Object<string,{col:number,row:number}>, start?: {col:number,row:number}}} [opts]
 * @returns {Array<object>} the same stop objects (copied), in walking order, each with `step` (1-based)
 */
export function planPickRoute(stops, opts = {}) {
  const list = Array.isArray(stops) ? stops : [];
  const located = list.filter(isLocated);
  const unlocated = list.filter((s) => !isLocated(s));

  const zones = [...new Set(located.map((s) => String(s.zone).toUpperCase()))];
  const out = [];
  for (const zone of orderZones(zones, opts.zoneGrid, opts.start)) {
    const inZone = located.filter((s) => String(s.zone).toUpperCase() === zone);
    const racks = [...new Set(inZone.map((s) => num(s.depth)))].sort((a, b) => a - b);
    racks.forEach((rack, k) => {
      const dir = k % 2 === 0 ? 1 : -1; // snake: forward on the 1st rack, back on the 2nd, ...
      const here = inZone.filter((s) => num(s.depth) === rack);
      here.sort((a, b) => (num(a.bin) - num(b.bin)) * dir || num(a.level) - num(b.level) || num(a.row) - num(b.row));
      out.push(...here);
    });
  }
  out.push(...unlocated);
  return out.map((s, i) => ({ ...s, step: i + 1 }));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One short, plain sentence on how to get from the stop you are at to the next one. `from` may be
 * null (the very first stop).
 */
export function describeMove(from, to, { depthLabel } = {}) {
  if (!to) return '';
  if (!isLocated(to)) return 'No bin location on file for this one — look it up, or ask.';
  const rackName = (z, d) => (typeof depthLabel === 'function' ? depthLabel(z, d) : `rack ${d}`);
  if (!isLocated(from)) return `Go to zone ${String(to.zone).toUpperCase()}, ${rackName(to.zone, num(to.depth))}.`;
  const fz = String(from.zone).toUpperCase();
  const tz = String(to.zone).toUpperCase();
  if (fz !== tz) return `Walk over to zone ${tz}.`;
  if (num(from.depth) !== num(to.depth)) return `Move on to ${rackName(tz, num(to.depth))}.`;
  const along = Math.abs(num(to.bin) - num(from.bin));
  const dir = num(to.bin) > num(from.bin) ? 'further along' : 'back';
  if (along === 0) {
    const up = num(to.level) - num(from.level);
    if (up === 0) return num(to.row) === num(from.row) ? 'Same spot — right next to the last one.' : 'Same bin, a little further back.';
    return up > 0 ? `Same bin, ${plural(up, 'shelf', 'shelves')} up.` : `Same bin, ${plural(-up, 'shelf', 'shelves')} down.`;
  }
  return `Same rack, ${plural(along, 'bin')} ${dir}.`;
}
