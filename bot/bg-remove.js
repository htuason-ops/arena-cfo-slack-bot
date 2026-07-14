// Server-side headshot background removal + crop-to-subject, ported from the
// browser-based canvas implementation in the original design reference
// (design_references/MeetYourCfo.dc.html, method `removeBg`). Same approach,
// just run with `sharp` instead of an in-browser <canvas>:
//
//   1. Downscale to a manageable size.
//   2. Sample "background" reference colors from the top edge + upper
//      corners (a headshot's subject sits lower/centered).
//   3. Classify each pixel as background if it's light+neutral, light+green
//      (common studio backdrop colors), or close to one of the sampled
//      reference colors.
//   4. Flood-fill background starting only from the image border, so
//      interior light areas (a white shirt, teeth) are preserved even if
//      they'd otherwise match the background classifier.
//   5. Zero out alpha for background pixels, soften the cutout edge, then
//      crop to the bounding box of what's left — for a typical headshot
//      (subject filling most of the frame) this naturally produces a
//      head-and-shoulders crop with the background gone.
//
// Returns a PNG buffer with transparency. Throws if no subject could be
// detected (e.g., the whole image reads as background) — callers should
// catch this and fall back to the original photo, same as the original
// browser version did ("Using photo as-is (auto-cut skipped)").

const sharp = require('sharp');

const MAX_DIMENSION = 1600;
const BG_COLOR_TOLERANCE = 92;

async function removeBackgroundAndCrop(inputBuffer) {
  const oriented = sharp(inputBuffer).rotate(); // respect EXIF orientation
  const meta = await oriented.metadata();
  const scale = Math.min(1, MAX_DIMENSION / Math.max(meta.width, meta.height));
  const targetW = Math.max(1, Math.round(meta.width * scale));
  const targetH = Math.max(1, Math.round(meta.height * scale));

  const { data, info } = await oriented
    .resize(targetW, targetH, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const n = w * h;

  const at = (x, y) => {
    const cx = Math.max(0, Math.min(w - 1, x | 0));
    const cy = Math.max(0, Math.min(h - 1, y | 0));
    const o = (cy * w + cx) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  };

  const refPoints = [
    [0, 0], [w - 1, 0], [w >> 1, 0], [w >> 3, 0], [w - (w >> 3), 0],
    [0, h * 0.12], [w - 1, h * 0.12],
  ];
  const refs = refPoints.map(([x, y]) => at(x, y));

  const isBg = (pixelIndex) => {
    const o = pixelIndex * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const warm = r - b;
    const green = g - Math.max(r, b);
    if (lum > 178 && warm < 22) return true;
    if (lum > 120 && green > 12 && b < g) return true;
    for (let k = 0; k < refs.length; k++) {
      const ref = refs[k];
      if (Math.abs(r - ref[0]) + Math.abs(g - ref[1]) + Math.abs(b - ref[2]) < BG_COLOR_TOLERANCE) {
        return true;
      }
    }
    return false;
  };

  const bg = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const push = (p) => {
    if (!seen[p] && isBg(p)) {
      seen[p] = 1;
      bg[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  for (let p = 0; p < n; p++) {
    if (bg[p]) data[p * 4 + 3] = 0;
  }
  // Soften the cutout edge one pixel in, matching the browser version.
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!bg[p] && (bg[p - 1] || bg[p + 1] || bg[p - w] || bg[p + w])) {
        data[p * 4 + 3] = 200;
      }
    }
  }

  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let p = 0; p < n; p++) {
    if (!bg[p]) {
      const x = p % w;
      const y = (p / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) {
    throw new Error('Background removal found no subject (entire image classified as background)');
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .png()
    .toBuffer();
}

module.exports = { removeBackgroundAndCrop };
