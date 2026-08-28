// Perspective correction ("straighten a rack photo like CamScanner straightens a page") — mark
// the 4 corners of a rack/aisle face in a photo taken at an angle, and this rectifies it into a
// flat, top-down-looking rectangle via a projective transform (homography) solved from those 4
// point correspondences, the same linear-algebra approach document scanners use.
//
// STATUS: wired in. The Warehouse page's "📷 Aisle / Rack Photos" section (index.html) uses this
// via a <script type="module"> bridge near the end of the document that assigns the whole module
// to window.PerspectiveWarp, since the rest of the app is one classic script and can't `import`
// directly. Clicking "📐" on a rack photo opens a corner-editing view: drag 4 handles onto the
// rack's corners, "✅ Straighten" calls warpImageToRect() to preview the rectified result, and
// "✏️ Adjust Corners" goes back to move them again before "💾 Save". The corner points (and
// optional measurement calibration, if set) are stored in warehouse_rack_images.grid_overlay
// (jsonb, already in the schema — see the shape documented below); the rectified image is
// re-uploaded as a second file alongside the original photo, which is kept as-is since re-editing
// corners needs the unwarped source, not the already-straightened result.
//
// grid_overlay shape (jsonb column on warehouse_rack_images), once this is wired in:
//   {
//     corners: [{x,y}, {x,y}, {x,y}, {x,y}],   // in the ORIGINAL photo's pixel space, clockwise
//                                                // from top-left, marking the rack face to rectify
//     rectifiedWidth: number, rectifiedHeight: number,  // output size the warp was rendered at
//     rectifiedImageUrl: string | null,          // where the corrected image was uploaded, if saved
//     calibration: {                              // optional — see the measurement functions below
//       p1: {x,y}, p2: {x,y},                    // two points, in the RECTIFIED image's pixel space
//       realDistance: number, unit: string,       // what that pixel distance actually measures
//       unitsPerPixel: number
//     } | null
//   }
//
// Math: solveHomography() sets up and solves the standard 8-equation/8-unknown linear system for
// a planar homography (4 point correspondences, h33 normalized to 1) via Gaussian elimination.
// warpImageToRect() then uses the *inverse* of that matrix to do inverse mapping — for every
// pixel in the output rectangle, look up where it came from in the source photo, so the output
// has no holes (the alternative, forward-mapping every source pixel into the output, would leave
// gaps wherever the transform stretches the image). Bilinear interpolation smooths the sampling.
//
// Usage (browser only — warpImageToRect() needs `document` and canvas):
//   import { warpImageToRect } from './perspective-warp.js';
//   const corners = [{x:40,y:30}, {x:520,y:60}, {x:500,y:400}, {x:20,y:380}]; // top-left, top-right, bottom-right, bottom-left
//   const rectified = await warpImageToRect(imageElement, corners, 600, 450);
//   rectified.toBlob((blob) => { ... }); // upload it like any other canvas-derived image

// ---- Linear algebra ----

// Solves Ax = b for a square system via Gaussian elimination with partial pivoting. A is an
// array of N row arrays (each length N), b is length N. Returns the solution vector, or null if
// the system is singular (shouldn't happen for 4 non-degenerate point correspondences).
export function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]); // augmented matrix

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    if (Math.abs(M[pivotRow][col]) < 1e-12) return null; // singular
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Solves for the 3x3 homography (flat 9-element row-major array, h9 normalized to 1) mapping
// each srcPoints[i] to dstPoints[i], given exactly 4 point correspondences (the minimum needed
// for a full projective transform — 8 degrees of freedom, 2 equations per point).
export function solveHomography(srcPoints, dstPoints) {
  if (srcPoints.length !== 4 || dstPoints.length !== 4) {
    throw new Error('solveHomography: exactly 4 point correspondences are required');
  }
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = srcPoints[i];
    const { x: X, y: Y } = dstPoints[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  const h = solveLinearSystem(A, b);
  if (!h) throw new Error('solveHomography: point correspondences are degenerate (e.g. collinear corners)');
  return [...h, 1];
}

// Standard 3x3 matrix inverse via the adjugate/determinant method. m and the return value are
// flat 9-element row-major arrays. Used to go from a src->dst homography to the dst->src one
// warpImageToRect() actually samples with (inverse mapping — see the module header).
export function invertMatrix3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('invertMatrix3x3: matrix is singular');
  const invDet = 1 / det;
  return [A * invDet, D * invDet, G * invDet, B * invDet, E * invDet, H * invDet, C * invDet, F * invDet, I * invDet];
}

export function multiplyMatrix3x3(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

// Applies a homography to a single point, including the perspective divide (dividing by the
// homogeneous w component) — this is what makes it a projective transform rather than just an
// affine one, and is what lets a trapezoid (a photo taken at an angle) map onto a true rectangle.
export function applyMatrix3x3(m, point) {
  const w = m[6] * point.x + m[7] * point.y + m[8];
  return {
    x: (m[0] * point.x + m[1] * point.y + m[2]) / w,
    y: (m[3] * point.x + m[4] * point.y + m[5]) / w,
  };
}

// ---- Image warping (browser only) ----

// image: an HTMLImageElement, HTMLCanvasElement, or ImageBitmap. srcCorners: the 4 points
// marking the rack face in the source image's pixel space, clockwise from top-left. Returns a
// new canvas of size outputWidth x outputHeight holding the rectified result.
export async function warpImageToRect(image, srcCorners, outputWidth, outputHeight) {
  const dstCorners = [
    { x: 0, y: 0 }, { x: outputWidth, y: 0 },
    { x: outputWidth, y: outputHeight }, { x: 0, y: outputHeight },
  ];
  const forward = solveHomography(srcCorners, dstCorners);
  const inverse = invertMatrix3x3(forward); // dst -> src, for inverse (hole-free) sampling

  const srcWidth = image.naturalWidth || image.width;
  const srcHeight = image.naturalHeight || image.height;
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcWidth;
  srcCanvas.height = srcHeight;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  srcCtx.drawImage(image, 0, 0, srcWidth, srcHeight);
  const srcData = srcCtx.getImageData(0, 0, srcWidth, srcHeight);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outputWidth;
  outCanvas.height = outputHeight;
  const outCtx = outCanvas.getContext('2d');
  const outData = outCtx.createImageData(outputWidth, outputHeight);

  for (let dy = 0; dy < outputHeight; dy++) {
    for (let dx = 0; dx < outputWidth; dx++) {
      const src = applyMatrix3x3(inverse, { x: dx + 0.5, y: dy + 0.5 });
      const [r, g, b, a] = sampleBilinear(srcData, src.x, src.y);
      const idx = (dy * outputWidth + dx) * 4;
      outData.data[idx] = r; outData.data[idx + 1] = g; outData.data[idx + 2] = b; outData.data[idx + 3] = a;
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}

// Exported standalone so the sampling math is testable without a real ImageData/canvas — callers
// can pass a plain { width, height, data } object shaped like ImageData.
export function sampleBilinear(imageData, x, y) {
  const { width, height, data } = imageData;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return [0, 0, 0, 0];
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0, fy = y - y0;
  const get = (px, py, c) => data[(py * width + px) * 4 + c];
  const lerp = (a, b, t) => a + (b - a) * t;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = lerp(get(x0, y0, c), get(x1, y0, c), fx);
    const bot = lerp(get(x0, y1, c), get(x1, y1, c), fx);
    out[c] = Math.round(lerp(top, bot, fy));
  }
  return out;
}

// ---- Optional measurement calibration ----
// Draw two points in the rectified image and say what real-world distance they span (e.g. "this
// is the shelf height, 45cm") to convert pixel distances elsewhere in that same rectified image
// into real units — accurate as long as the rack face was genuinely planar and the correction
// above was applied first (measuring on the original angled photo would not be accurate).

export function distanceBetweenPoints(p1, p2) {
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

// Real-world units per pixel, e.g. cm/px — multiply a pixel distance by this to get real units.
export function computeScale(pixelDistance, knownRealDistance) {
  if (!(pixelDistance > 0) || !(knownRealDistance > 0)) {
    throw new Error('computeScale: both pixelDistance and knownRealDistance must be positive');
  }
  return knownRealDistance / pixelDistance;
}

export function pixelsToReal(pixelDistance, unitsPerPixel) {
  return pixelDistance * unitsPerPixel;
}

export function realToPixels(realDistance, unitsPerPixel) {
  return realDistance / unitsPerPixel;
}
