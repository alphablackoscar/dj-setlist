// メモリーＱ検出の材料を作る。**小節ごとの音の中身**を出すところまで。
//
// なぜ features.db を使わないか（2026-10-17 に実測）:
//   解析は `EXCERPT_SEC=60` の 1 窓だけで、`window_start` は曲の中ほど（最大 366 秒）。
//   **イントロもアウトロも解析範囲に入っていない。** 構造を見るには全長が要る。
//   全長デコードは 1 曲 0.20 秒（mp3/aiff/m4a で実測、×1000 速）なので、ここで毎回やってよい。
//
// 小節線は **rekordbox のビートグリッドをそのまま使う**（collection.xml の `<TEMPO>`）。
// 自前でビートを取り直さない。ユーザーが手で直したグリッドが正解であり、
// Ｑは必ずその上に乗る（実測: 手打ちＱの 97.5% が拍の上、94.4% が小節頭）。

import { execFileSync } from 'node:child_process';

export const SR = 11025;          // 構造を見るだけなので低くてよい。デコードが速くなる
const FRAME = 2048, HOP = 1024;
/** 12 本の対数帯域（Hz）。キック〜ハットまでを粗く分ける */
const BAND_EDGES = [40, 80, 120, 200, 300, 450, 700, 1100, 1700, 2600, 4000, 5500];

/** その場 radix-2 FFT。依存ゼロの約束があるので自前で持つ */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** ffmpeg で全長をモノラル 11025Hz に落とす */
export function decode(file) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'],
    { maxBuffer: 1 << 30 });
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
}

/**
 * **rekordbox のグリッドを実速に直す。** 2026-10-19 追加。
 *
 * rekordbox は 800 曲で BPM を倍/半分に記録している（hiphop/latin が 180-200、
 * 4 つ打ちが 67 など）。グリッドの**位置**は正しいが**刻みの単位**が違う。
 * そのまま「8 小節」と数えると、実際には 16 小節だったり 4 小節だったりする。
 * （実測 2026-10-19: 67 BPM の曲で、メインの頭が「17 小節目」として出てしまった）
 *
 * 直し方は BPM を倍/半分にするだけでよい。**小節線は必ず元の拍の上に乗る**
 * （134 の小節頭は 67 の拍 1 と拍 3 / 100 の小節頭は 200 の 1 小節おき）。
 * ユーザー判断 2026-10-19:「XML が 200 でも 100 として扱い、書き出しにも 100 と書く」。
 *
 * @param measuredBpm features.db の bpm_measured。無ければ何もしない
 */
export function trueTempos(tempos, measuredBpm) {
  if (!measuredBpm || !tempos.length) return tempos;
  const near = (a, b) => Math.abs(a - b) / b < 0.03;
  const x = tempos[0].bpm;
  let f = 1;
  if (near(x * 2, measuredBpm)) f = 2;          // グリッドが半分の速さ（67 → 134）
  else if (near(x / 2, measuredBpm)) f = 0.5;   // グリッドが倍の速さ（200 → 100）
  if (f === 1) return tempos;
  return tempos.map((t) => ({ ...t, bpm: t.bpm * f }));
}

/**
 * ビートの時刻。`<TEMPO Inizio Bpm Battito>` を順に辿る（**可変グリッドの曲が 692 ある**）。
 * `Battito` は小節内の拍（1-4）。区間の頭で取り直す。
 */
export function beatTimes(tempos, durSec) {
  const out = [];
  let phase = (tempos[0].bat - 1) % 4;
  for (let i = 0; i < tempos.length; i++) {
    const a = tempos[i], end = tempos[i + 1] ? tempos[i + 1].i : durSec, step = 60 / a.bpm;
    if (i > 0) phase = (a.bat - 1) % 4;
    let k = 0;
    for (let t = a.i; t < end - 1e-9; t += step, k++) out.push({ t, bar: ((phase + k) % 4) === 0 });
  }
  return out;
}

/**
 * 小節ごとの特徴量。
 * - `band[12]`: 対数帯域のエネルギー（その曲の中で 0-1 に正規化。曲間の音量差を持ち込まない）
 * - `full` / `low` / `mid` / `high`: 粗い読み（しきい値判定に使う）
 */
export function barFeatures(pcm, beats) {
  const nFrames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
  const win = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1));
  const nb = BAND_EDGES.length - 1;
  const frameBand = new Float32Array(nFrames * nb);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  const binHz = SR / FRAME;
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = (pcm[off + i] / 32768) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < nb; b++) {
      const lo = Math.max(1, Math.floor(BAND_EDGES[b] / binHz));
      const hi = Math.min(FRAME / 2, Math.ceil(BAND_EDGES[b + 1] / binHz));
      let v = 0;
      for (let k = lo; k < hi; k++) v += re[k] * re[k] + im[k] * im[k];
      frameBand[f * nb + b] = Math.sqrt(v / Math.max(1, hi - lo));
    }
  }
  // 小節（4 拍）ごとにまとめる
  const barIdx = [];
  for (let i = 0; i < beats.length; i++) if (beats[i].bar) barIdx.push(i);
  const bars = [];
  for (let i = 0; i < barIdx.length - 1; i++) {
    const s = beats[barIdx[i]].t, e = beats[barIdx[i + 1]].t;
    const f0 = Math.floor(s * SR / HOP), f1 = Math.min(nFrames, Math.ceil(e * SR / HOP));
    if (f1 <= f0) break;
    const band = new Float32Array(nb);
    for (let f = f0; f < f1; f++) for (let b = 0; b < nb; b++) band[b] += frameBand[f * nb + b];
    for (let b = 0; b < nb; b++) band[b] /= (f1 - f0);
    const sum = (a, z) => { let v = 0; for (let b = a; b < z; b++) v += band[b] * band[b]; return Math.sqrt(v); };
    bars.push({ t: s, band, full: sum(0, nb), low: sum(0, 3), mid: sum(4, 9), high: sum(9, nb) });
  }
  // 曲の中で正規化する。**曲間の音量差を持ち込まない**（マスタリングの差で判定が動く）
  const norm = (k) => { const m = Math.max(...bars.map((b) => b[k])) || 1; for (const b of bars) b[k] /= m; };
  for (const k of ['full', 'low', 'mid', 'high']) norm(k);
  for (const b of bars) {
    let n = 0; for (let i = 0; i < nb; i++) n += b.band[i] * b.band[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < nb; i++) b.band[i] /= n;     // L2 正規化 = 内積が cosine になる
  }
  return bars;
}

/** XML の 1 曲ぶんから TEMPO を読む */
export function tempoOf(trackXml) {
  return [...trackXml.matchAll(/<TEMPO Inizio="([\d.]+)" Bpm="([\d.]+)" Metro="([^"]*)" Battito="(\d+)"/g)]
    .map((m) => ({ i: +m[1], bpm: +m[2], bat: +m[4] }));
}
