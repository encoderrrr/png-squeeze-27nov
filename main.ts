// png-squeeze: a lossless PNG re-encoder that squeezes 1280x720 RGBA screenshots
// into the smallest valid PNG it can, inside one 60-second run over a set of 8.
//
// Strategy, per image:
//   1. Decode the stored RGBA PNG with our own decoder.
//   2. Analyse the pixels: opaque? grey? at most 256 distinct colours?
//      From that, build every lossless form the image can take:
//        - palette (colour type 3) when it has at most 256 colours, in two
//          entry orders (most frequent first, darkest first), transparent
//          entries first so tRNS stays short;
//        - grey (type 0) or grey+alpha (type 4) when every pixel is grey;
//        - RGB (type 2) or RGBA (type 6) otherwise, with a tRNS key instead
//          of an alpha channel when there is exactly one transparent value.
//   3. Screen every form: one pass filters each row five ways and scores
//      three strategies at once (every row unfiltered, minimum-sum,
//      Laplace-entropy cost); the form whose best strategy deflates
//      smallest at zlib level 6 wins. (A fewest-distinct-pairs strategy
//      was tried and dropped: its stamp-table scoring cost seconds on
//      noisy images, and Laplace plus brute force already beat it on
//      every practice image.)
//   4. Refine the winning form: screen its strategies at zlib level 6
//      on full data and keep the smallest. For one-byte-per-pixel forms
//      only, also try brute force: each row's five filters weighed by
//      actually deflating the row against the 32 KiB already written
//      (cross-row LZ77 matches count). Brute force is skipped for wider
//      forms: there it costs seconds and gains almost nothing, and on
//      noisy images it can even lose to leaving rows unfiltered.
//   5. Deflate the winning filtered data and keep the smallest stream.
//      The level follows the data: level 9 where its long match chains
//      are fast and buy up to a tenth, level 7 where the filtered data
//      holds few long matches and level 9 would crawl. One IDAT, one
//      zlib stream.
//
// Everything is deterministic: fixed iteration orders, fixed tie-breaks
// (lowest filter type, first form on a tie), no clock, no randomness, no
// environment read except the input/output directories. Node 22 built-ins
// only: node:fs, node:path, node:zlib.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// ---------------------------------------------------------------- CRC-32

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------- PNG out

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdr(width, height, colourType) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8;
  data[9] = colourType;
  return data;
}

function pngOf(width, height, colourType, plte, trns, idat) {
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', ihdr(width, height, colourType))];
  if (plte !== null) parts.push(chunk('PLTE', plte));
  if (trns !== null) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- PNG in

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (at + 12 + len > bytes.length) throw new Error('truncated chunk ' + type);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error('bad CRC on ' + type);
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      colourType = data[9];
      if (!(colourType in CHANNELS)) throw new Error('unsupported colour type ' + colourType);
      if (data[12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error('unexpected chunk ' + type);
    }
  }
  if (!ended || idat.length === 0) throw new Error('no IEND or no IDAT');
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('inflated size mismatch');
  // Unfilter into samples.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? samples[dst + i - bpp] : 0;
      const above = y > 0 ? samples[up + i] : 0;
      const upLeft = y > 0 && i >= bpp ? samples[up + i - bpp] : 0;
      let predict = 0;
      if (filter === 1) predict = left;
      else if (filter === 2) predict = above;
      else if (filter === 3) predict = (left + above) >> 1;
      else if (filter === 4) predict = paethPredictor(left, above, upLeft);
      else if (filter !== 0) throw new Error('bad filter type ' + filter);
      samples[dst + i] = raw[src + i] + predict;
    }
  }
  // Expand samples to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- Analysis

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const view = new DataView(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const word = view.getUint32(d, true);
      const k = counts.get(word);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(word, 1);
      } else {
        counts.set(word, k + 1);
      }
    }
  }
  let colours = null;
  if (!many) {
    colours = [];
    for (const [word, count] of counts) {
      colours.push({
        word,
        count,
        r: word & 0xff,
        g: (word >>> 8) & 0xff,
        b: (word >>> 16) & 0xff,
        a: (word >>> 24) & 0xff,
      });
    }
  }
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an
// alpha channel: every non-opaque pixel is alpha 0 with that value, and no
// opaque pixel shares the value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, colourType) {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (colourType === 0) out[s] = rgba[d];
    else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function luminance(c) {
  return 299 * c.r + 587 * c.g + 114 * c.b;
}

function paletteForm(rgba, colours, order) {
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return luminance(x) - luminance(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const view = new DataView(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(view.getUint32(i * 4, true));
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// Every lossless form this image can take.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let colourType;
  let trns = null;
  if (grey) {
    colourType = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = opaque || key !== null ? 2 : 6;
    if (key !== null) {
      trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
    }
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  forms.push({ colourType, bpp, samples: samplesOf(rgba, colourType), plte: null, trns });
  return forms;
}

// ---------------------------------------------------------------- Filters

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredictor(a, b, c);
    }
  }
}

// Cost of a filtered byte under a fixed Laplace prior on the signed value:
// filtered bytes cluster near zero, so a byte far from zero costs more.
// A fixed table keeps this strategy usable in the same single pass as the
// others, with no histogram pass over the image first.
const LAPLACE_COST = (() => {
  const cost = new Float64Array(256);
  const scale = 12;
  let total = 0;
  const weight = new Float64Array(256);
  for (let b = 0; b < 256; b++) {
    const v = b < 128 ? b : b - 256;
    weight[b] = Math.exp(-Math.abs(v) / scale);
    total += weight[b];
  }
  for (let b = 0; b < 256; b++) cost[b] = -Math.log2(weight[b] / total);
  return cost;
})();

// The two per-row scores of one filtered trial, in a single pass over
// its bytes: the signed sum and the Laplace-entropy cost. One pass
// instead of two keeps the single-pass filter search cheap enough for
// the 60-second wall on noisy sets too.
function trialScores(row) {
  let sum = 0;
  let laplace = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    sum += v < 128 ? v : 256 - v;
    laplace += LAPLACE_COST[v];
  }
  return { sum, laplace };
}

// Filter strategies scored in one pass: every row unfiltered, minimum
// signed sum, and lowest Laplace-entropy cost. Each row's five filtered
// variants are computed once and shared by all strategies. Only the
// three strategies that ever reach the deflate round get a buffer;
// the other fixed filters are never written out. Returns one filtered
// buffer per strategy, keyed by name.
function filterCandidates(samples, width, height, bpp) {
  const stride = width * bpp;
  const names = ['f0', 'minsum', 'laplace'];
  const raws = {};
  for (const name of names) raws[name] = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    for (let t = 0; t < 5; t++) filterRow(t, cur, prev, bpp, trials[t]);
    let minsumType = 0;
    let minsumBest = Infinity;
    let laplaceType = 0;
    let laplaceBest = Infinity;
    for (let t = 0; t < 5; t++) {
      const { sum, laplace } = trialScores(trials[t]);
      if (sum < minsumBest) {
        minsumBest = sum;
        minsumType = t;
      }
      if (laplace < laplaceBest) {
        laplaceBest = laplace;
        laplaceType = t;
      }
    }
    const at = y * (stride + 1);
    const chosen = { f0: 0, minsum: minsumType, laplace: laplaceType };
    for (const name of names) {
      const raw = raws[name];
      raw[at] = chosen[name];
      raw.set(trials[chosen[name]], at + 1);
    }
  }
  return raws;
}

// Brute force, for one-byte-per-pixel forms only: weigh each row's five
// filters by deflating the row against the 32 KiB already written, at
// level 4. Greedy per row, in order, so a row's choice never changes what
// an earlier row wrote.
function bruteFiltered(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    for (let t = 0; t < 5; t++) filterRow(t, cur, prev, bpp, trials[t]);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let best = Infinity;
    let type = 0;
    for (let t = 0; t < 5; t++) {
      const row = new Uint8Array(stride + 1);
      row[0] = t;
      row.set(trials[t], 1);
      const size = deflateSync(row, {
        level: 4,
        memLevel: 9,
        dictionary: before.length === 0 ? undefined : before,
      }).length;
      if (size < best) {
        best = size;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trials[type], at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------- Encoding

const CHUNK_OVERHEAD = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

function encodeImage(rgba, width, height) {
  const forms = formsOf(rgba);
  // Screen every form on two cheap strategies at zlib level 6, on full
  // data. (A strided row-sample was tried for this and dropped: it
  // breaks the cross-row deflate continuity the adaptive filters live
  // on, and mis-ranks strategies.) Keep the smallest form.
  let bestForm = null;
  let bestFormCandidates = null;
  let bestScreen = Infinity;
  for (const form of forms) {
    const candidates = filterCandidates(form.samples, width, height, form.bpp);
    let formBest = Infinity;
    for (const name of ['minsum', 'f0']) {
      const bytes = deflateSync(candidates[name], { level: 6, memLevel: 8 }).length + CHUNK_OVERHEAD(form);
      if (bytes < formBest) formBest = bytes;
    }
    if (formBest < bestScreen) {
      bestScreen = formBest;
      bestForm = form;
      bestFormCandidates = candidates;
    }
  }
  const form = bestForm;
  // Refine the winning form: screen the strategies that ever win at
  // level 6 on full data, and keep the smallest filtered data, with
  // its level-6 size for the level choice below. For one-byte-per-pixel
  // forms, brute force joins the screen too.
  const raws = { ...bestFormCandidates };
  if (form.bpp === 1) raws.brute = bruteFiltered(form.samples, width, height, form.bpp);
  let bestRaw = null;
  let bestFull6 = Infinity;
  for (const name of ['minsum', 'laplace', 'f0', 'brute']) {
    if (!(name in raws)) continue;
    const bytes = deflateSync(raws[name], { level: 6, memLevel: 8 }).length;
    if (bytes < bestFull6) {
      bestFull6 = bytes;
      bestRaw = raws[name];
    }
  }
  // Deflate the winning filtered data and keep the smallest stream. The
  // level follows the data: level 9's 4096-long match chains take
  // seconds a deflate when the filtered data holds few long matches,
  // which the level-6 ratio shows (a ratio above 0.10 means level 9
  // crawls), so those images get level 7, whose chains are 32 times
  // shorter; compressible images, where level 9 is fast and buys up to
  // a tenth, get level 9. Smaller memLevels win on this data, and the
  // filtered strategy wins on the noisiest image, so both are tried.
  const ratio = bestFull6 / bestRaw.length;
  const level = ratio < 0.1 ? 9 : 7;
  const settings =
    bestRaw.length <= 1048576
      ? [
          { level, memLevel: 9, strategy: 0 },
          { level, memLevel: 6, strategy: 0 },
          { level, memLevel: 5, strategy: 0 },
          { level, memLevel: 6, strategy: 1 },
        ]
      : [
          { level, memLevel: 6, strategy: 0 },
          { level, memLevel: 6, strategy: 1 },
        ];
  let bestIdat = null;
  let bestIdatBytes = Infinity;
  for (const options of settings) {
    const idat = deflateSync(bestRaw, options);
    if (idat.length < bestIdatBytes) {
      bestIdatBytes = idat.length;
      bestIdat = idat;
    }
  }
  return pngOf(width, height, form.colourType, form.plte, form.trns, bestIdat);
}

// ---------------------------------------------------------------- Main

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), encodeImage(image.rgba, image.width, image.height));
}
