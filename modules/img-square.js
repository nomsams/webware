// Pads an image out to a square canvas, filling the new space with a solid color or an
// automatically-detected color sampled from the image's own edges.
// Ported from https://github.com/nomsams/imgsquare — algorithm re-derived (average edge-pixel
// color) rather than copied line-for-line; re-check against the original if exact parity with
// its output matters.
//
// STATUS: standalone, not wired into the item-photo editor in index.html yet. The intended
// integration point is the existing canvas-based image editor used for item photos and
// manufacturer logos — this would slot in as an extra "square it off" step before crop/rotate.
//
// Usage (browser only — squareImage() needs `document` and canvas):
//   import { squareImage, averageEdgeColor } from './img-square.js';
//   const canvas = await squareImage(imageElementOrBitmap, { fill: 'auto' });
//   canvas.toBlob((blob) => { ... });

// Averages the RGB of every pixel along the outer 1px border of an ImageData, ignoring fully
// transparent pixels. Returns '#rrggbb'. Exported standalone (pure function, no canvas) so it's
// unit-testable without a DOM.
export function averageEdgeColor(imageData) {
  const { data, width, height } = imageData;
  let r = 0, g = 0, b = 0, count = 0;

  function accumulate(x, y) {
    const i = (y * width + x) * 4;
    if (data[i + 3] === 0) return; // skip transparent
    r += data[i]; g += data[i + 1]; b += data[i + 2];
    count++;
  }

  for (let x = 0; x < width; x++) { accumulate(x, 0); accumulate(x, height - 1); }
  for (let y = 0; y < height; y++) { accumulate(0, y); accumulate(width - 1, y); }

  if (count === 0) return '#ffffff'; // fully transparent border — fall back to white
  return rgbToHex(Math.round(r / count), Math.round(g / count), Math.round(b / count));
}

export function rgbToHex(r, g, b) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// image: an HTMLImageElement, HTMLCanvasElement, or ImageBitmap (anything drawImage() accepts).
// fill: '#rrggbb', a CSS color string, or 'auto' (default) to sample averageEdgeColor from the
// source image's own border.
export async function squareImage(image, { fill = 'auto' } = {}) {
  const srcWidth = image.naturalWidth || image.width;
  const srcHeight = image.naturalHeight || image.height;
  const size = Math.max(srcWidth, srcHeight);

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcWidth;
  srcCanvas.height = srcHeight;
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(image, 0, 0, srcWidth, srcHeight);

  const fillColor = fill === 'auto'
    ? averageEdgeColor(srcCtx.getImageData(0, 0, srcWidth, srcHeight))
    : fill;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = size;
  outCanvas.height = size;
  const ctx = outCanvas.getContext('2d');
  ctx.fillStyle = fillColor;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(image, (size - srcWidth) / 2, (size - srcHeight) / 2, srcWidth, srcHeight);

  return outCanvas;
}
