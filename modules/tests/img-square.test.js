// squareImage() itself needs `document`/canvas and is browser-only — only the pure color-math
// pieces are unit tested here.
//
// Run: node --test modules/tests/img-square.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageEdgeColor, rgbToHex } from '../img-square.js';

test('rgbToHex formats and clamps', () => {
  assert.equal(rgbToHex(255, 0, 128), '#ff0080');
  assert.equal(rgbToHex(0, 0, 0), '#000000');
  assert.equal(rgbToHex(300, -10, 12.6), '#ff000d'); // clamps out-of-range, rounds fractional
});

function makeImageData(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = fill(Math.floor(i / 4) % width, Math.floor(i / 4 / width));
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return { data, width, height };
}

test('averageEdgeColor averages a solid-color border', () => {
  const imageData = makeImageData(4, 4, () => [100, 150, 200, 255]);
  assert.equal(averageEdgeColor(imageData), rgbToHex(100, 150, 200));
});

test('averageEdgeColor ignores fully transparent border pixels', () => {
  // Border is transparent except one opaque red pixel.
  const imageData = makeImageData(4, 4, (x, y) => {
    const onBorder = x === 0 || x === 3 || y === 0 || y === 3;
    if (!onBorder) return [0, 0, 0, 0];
    if (x === 0 && y === 0) return [255, 0, 0, 255];
    return [0, 0, 0, 0]; // transparent
  });
  assert.equal(averageEdgeColor(imageData), rgbToHex(255, 0, 0));
});

test('averageEdgeColor falls back to white when the entire border is transparent', () => {
  const imageData = makeImageData(4, 4, () => [10, 10, 10, 0]);
  assert.equal(averageEdgeColor(imageData), '#ffffff');
});

test('averageEdgeColor only samples the border, not the interior', () => {
  const imageData = makeImageData(4, 4, (x, y) => {
    const onBorder = x === 0 || x === 3 || y === 0 || y === 3;
    return onBorder ? [0, 0, 0, 255] : [255, 255, 255, 255]; // white interior should be ignored
  });
  assert.equal(averageEdgeColor(imageData), '#000000');
});
