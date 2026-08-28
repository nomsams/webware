// warpImageToRect() needs `document`/canvas and is browser-only — everything else here is pure
// math, tested directly.
//
// Run: node --test modules/tests/perspective-warp.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solveLinearSystem, solveHomography, invertMatrix3x3, multiplyMatrix3x3, applyMatrix3x3,
  sampleBilinear, distanceBetweenPoints, computeScale, pixelsToReal, realToPixels,
} from '../perspective-warp.js';

function approxEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}
function approxPoint(p1, p2, eps = 1e-6) {
  return approxEqual(p1.x, p2.x, eps) && approxEqual(p1.y, p2.y, eps);
}

test('solveLinearSystem solves a simple known 2x2 system', () => {
  // x + y = 3, x - y = 1  ->  x=2, y=1
  const x = solveLinearSystem([[1, 1], [1, -1]], [3, 1]);
  assert.ok(approxEqual(x[0], 2) && approxEqual(x[1], 1));
});

test('solveLinearSystem returns null for a singular system', () => {
  const x = solveLinearSystem([[1, 2], [2, 4]], [1, 2]);
  assert.equal(x, null);
});

test('solveHomography on identity correspondences yields the identity matrix', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const H = solveHomography(square, square);
  for (const p of square) {
    assert.ok(approxPoint(applyMatrix3x3(H, p), p));
  }
});

test('solveHomography recovers a pure translation', () => {
  const src = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const dst = src.map(p => ({ x: p.x + 5, y: p.y + 3 }));
  const H = solveHomography(src, dst);
  src.forEach((p, i) => assert.ok(approxPoint(applyMatrix3x3(H, p), dst[i])));
});

test('solveHomography maps a real perspective quad (angled photo) onto a rectangle', () => {
  // A trapezoid shape — as if the right edge of the rack is further from the camera.
  const src = [{ x: 40, y: 30 }, { x: 520, y: 60 }, { x: 500, y: 400 }, { x: 20, y: 380 }];
  const dst = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 450 }, { x: 0, y: 450 }];
  const H = solveHomography(src, dst);
  src.forEach((p, i) => assert.ok(approxPoint(applyMatrix3x3(H, p), dst[i], 1e-4)));
});

test('solveHomography throws on degenerate (collinear) points', () => {
  const collinear = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
  const dst = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.throws(() => solveHomography(collinear, dst), /degenerate/);
});

test('solveHomography requires exactly 4 points each', () => {
  assert.throws(() => solveHomography([{ x: 0, y: 0 }], [{ x: 0, y: 0 }]), /exactly 4/);
});

test('invertMatrix3x3 composed with the original yields the identity matrix', () => {
  const src = [{ x: 40, y: 30 }, { x: 520, y: 60 }, { x: 500, y: 400 }, { x: 20, y: 380 }];
  const dst = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 450 }, { x: 0, y: 450 }];
  const H = solveHomography(src, dst);
  const Hinv = invertMatrix3x3(H);
  const identity = multiplyMatrix3x3(H, Hinv);
  const expected = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  identity.forEach((v, i) => assert.ok(approxEqual(v, expected[i], 1e-6)));
});

test('invertMatrix3x3 lets the inverse map destination points back to the source ones', () => {
  const src = [{ x: 40, y: 30 }, { x: 520, y: 60 }, { x: 500, y: 400 }, { x: 20, y: 380 }];
  const dst = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 450 }, { x: 0, y: 450 }];
  const H = solveHomography(src, dst);
  const Hinv = invertMatrix3x3(H);
  dst.forEach((p, i) => assert.ok(approxPoint(applyMatrix3x3(Hinv, p), src[i], 1e-3)));
});

test('invertMatrix3x3 throws on a singular matrix', () => {
  assert.throws(() => invertMatrix3x3([1, 2, 3, 2, 4, 6, 1, 1, 1]), /singular/);
});

test('multiplyMatrix3x3 with the identity is a no-op', () => {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const m = [2, 0, 5, 0, 3, 7, 0, 0, 1];
  assert.deepEqual(multiplyMatrix3x3(m, identity), m);
  assert.deepEqual(multiplyMatrix3x3(identity, m), m);
});

test('applyMatrix3x3 with the identity matrix returns the point unchanged', () => {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  assert.deepEqual(applyMatrix3x3(identity, { x: 12, y: 34 }), { x: 12, y: 34 });
});

test('applyMatrix3x3 applies a perspective divide, not just an affine transform', () => {
  // w = 2 for every point -> both coordinates get halved, which a pure affine matrix could not do
  // via the same row that also translates/scales x and y independently of position.
  const m = [1, 0, 0, 0, 1, 0, 0, 0, 2];
  assert.deepEqual(applyMatrix3x3(m, { x: 10, y: 20 }), { x: 5, y: 10 });
});

test('sampleBilinear returns the exact pixel color at integer coordinates', () => {
  const imageData = { width: 2, height: 2, data: new Uint8ClampedArray([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 0, 255,
  ]) };
  assert.deepEqual(sampleBilinear(imageData, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(sampleBilinear(imageData, 1, 0), [0, 255, 0, 255]);
});

test('sampleBilinear blends between pixels at a fractional coordinate', () => {
  const imageData = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255,   200, 200, 200, 255]) };
  assert.deepEqual(sampleBilinear(imageData, 0.5, 0), [100, 100, 100, 255]);
});

test('sampleBilinear returns transparent black outside the image bounds', () => {
  const imageData = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  assert.deepEqual(sampleBilinear(imageData, -1, 0), [0, 0, 0, 0]);
  assert.deepEqual(sampleBilinear(imageData, 5, 5), [0, 0, 0, 0]);
});

test('distanceBetweenPoints computes plain Euclidean distance', () => {
  assert.equal(distanceBetweenPoints({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test('computeScale + pixelsToReal round-trip a known measurement', () => {
  // Drew a 200px line representing a real 45cm shelf height.
  const scale = computeScale(200, 45);
  assert.ok(approxEqual(scale, 0.225));
  assert.ok(approxEqual(pixelsToReal(200, scale), 45));
  assert.ok(approxEqual(realToPixels(45, scale), 200));
});

test('computeScale rejects zero or negative distances', () => {
  assert.throws(() => computeScale(0, 45), /positive/);
  assert.throws(() => computeScale(200, -5), /positive/);
});
