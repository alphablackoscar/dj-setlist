// essentia.js (WASM) による古典的特徴量。docs/FEATURE_SPEC.md §4.1-4.4 の実装。
// Gate 0 で踏んだ制約:
//   - SuperFlux 系は 16kHz で例外 -> ここは 44.1kHz 専用
//   - FFT / CartesianToPolar が未バインド -> OnsetDetection は位相ゼロで 'hfc'
//   - MelBands / TriangularBands の直接呼び出しは失敗 -> band は MFCC 経由

import esPkg from 'essentia.js';
import { BAND_CURVE_LEN, EXCERPT_SEC, GRID_BANDS, GRID_STEPS, ONSET_CURVE_LEN, SR_DSP, WINDOW_HOP_SEC } from './types.ts';

const FRAME = 2048;
const HOP_ONSET = 512;
const HOP_SPEC = 1024;
const SPEC_BINS = FRAME / 2 + 1;

export type Essentia = any;

export function createEssentia(): Essentia {
  return new (esPkg as any).Essentia((esPkg as any).EssentiaWASM);
}

export interface DspFeatures {
  bpmMeasured: number; bpmConfidence: number; beatTicks: Float32Array;
  key: string; scale: string; keyStrength: number;
  rms: number; spectralCentroid: number; flux: number; lowEnergyRatio: number;
  zcr: number; danceabilityDsp: number;
  mfccMean: Float32Array; mfccVar: Float32Array;
  onsetCurve: Float32Array; onsetGrid: Float32Array; bandCurves: Float32Array;
}

/** 単一区間の解析。v0.3.0 では extractDspMulti から全体統計の算出にのみ使う */
function extractDsp(es: Essentia, signal: Float32Array, skipOnset = false): DspFeatures {
  const vec = es.arrayToVector(signal);
  try {
    // --- 4.1 リズム ---
    const rh = es.RhythmExtractor2013(vec, 208, 'multifeature', 40);
    const ticks = Float32Array.from(es.vectorToArray(rh.ticks));
    const bpm = rh.bpm;
    rh.ticks.delete(); rh.estimates.delete(); rh.bpmIntervals.delete();

    // --- 4.4 全体量 ---
    const rms = es.RMS(vec).rms;
    const zcr = es.ZeroCrossingRate(vec).zeroCrossingRate;
    const dance = es.Danceability(vec, 8800, 310, SR_DSP, 3.5);
    const danceabilityDsp = dance.danceability;
    dance.dfa.delete();
    const k = es.KeyExtractor(vec, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate', SR_DSP);

    // --- 4.2 / 4.3 onset 曲線と帯域別グリッド（hop 512） ---
    // extractDspMulti から呼ぶときは窓ごとに計算するため、連結信号ぶんは無駄。skipOnset で飛ばす
    if (skipOnset) {
      const spec0 = spectralPass(es, signal);
      return {
        bpmMeasured: bpm, bpmConfidence: rh.confidence, beatTicks: ticks,
        key: k.key, scale: k.scale, keyStrength: k.strength,
        rms, zcr, danceabilityDsp,
        spectralCentroid: spec0.centroid, flux: spec0.flux, lowEnergyRatio: spec0.lowEnergyRatio,
        mfccMean: spec0.mfccMean, mfccVar: spec0.mfccVar,
        onsetCurve: new Float32Array(ONSET_CURVE_LEN),
        onsetGrid: new Float32Array(GRID_BANDS.length * GRID_STEPS),
        bandCurves: new Float32Array(GRID_BANDS.length * BAND_CURVE_LEN),
      };
    }
    const { curve, bandNov } = onsetPass(es, signal);
    const onsetCurve = resample(curve, ONSET_CURVE_LEN);
    // 帯域別 novelty を曲線のまま保存する。グリッドの刻み・位相・解像度を後から変えられるようにするため
    const bandCurves = new Float32Array(GRID_BANDS.length * BAND_CURVE_LEN);
    for (let b = 0; b < bandNov.length; b++) bandCurves.set(resample(bandNov[b], BAND_CURVE_LEN), b * BAND_CURVE_LEN);
    const onsetGrid = foldGrid(bandNov, bpm, ticks.length ? ticks[0] : 0);

    // --- 4.4 スペクトル統計（hop 1024） ---
    const spec = spectralPass(es, signal);

    return {
      bpmMeasured: bpm, bpmConfidence: rh.confidence, beatTicks: ticks,
      key: k.key, scale: k.scale, keyStrength: k.strength,
      rms, zcr, danceabilityDsp,
      spectralCentroid: spec.centroid, flux: spec.flux, lowEnergyRatio: spec.lowEnergyRatio,
      mfccMean: spec.mfccMean, mfccVar: spec.mfccVar,
      onsetCurve, onsetGrid, bandCurves,
    };
  } finally {
    vec.delete();
  }
}

/** hop 512 で novelty 曲線と帯域別 novelty を作る */
function onsetPass(es: Essentia, signal: Float32Array) {
  const frames = es.FrameGenerator(signal, FRAME, HOP_ONSET);
  const zeroPhase = es.arrayToVector(new Float32Array(SPEC_BINS));
  const nFrames = frames.size();
  const curve = new Float32Array(nFrames);
  const nBands = GRID_BANDS.length;
  const bandNov: Float32Array[] = GRID_BANDS.map(() => new Float32Array(nFrames));
  const binHz = SR_DSP / FRAME;
  const ranges = GRID_BANDS.map(([lo, hi]) => [
    Math.max(0, Math.floor(lo / binHz)),
    Math.min(SPEC_BINS, Math.ceil(hi / binHz)),
  ] as [number, number]);
  const prevE = new Float64Array(nBands);

  try {
    for (let i = 0; i < nFrames; i++) {
      const frame = frames.get(i);
      const win = es.Windowing(frame, true, FRAME, 'hann');
      const specV = es.Spectrum(win.frame, FRAME).spectrum;
      const arr = es.vectorToArray(specV);

      // v0.2.0: 対数圧縮した帯域エネルギーの半波整流差分 = spectral flux 系 novelty。
      // v0.1.0 は OnsetDetection('hfc') の「絶対値」を曲線にしていたため、拍構造が出ず平坦になった
      //（Gate 2 不合格の直接原因。docs/DECISIONS.md 参照）。
      let frameNov = 0;
      for (let b = 0; b < nBands; b++) {
        let e = 0;
        for (let bin = ranges[b][0]; bin < ranges[b][1]; bin++) e += arr[bin] * arr[bin];
        const eLog = Math.log1p(e * 1e3);            // 圧縮しないと低域の絶対値に支配される
        const d = i === 0 ? 0 : Math.max(0, eLog - prevE[b]);
        bandNov[b][i] = d;
        frameNov += d;
        prevE[b] = eLog;
      }
      curve[i] = frameNov;                            // 全帯域の novelty 合計

      specV.delete();
      win.frame.delete();
      frame.delete();
    }
  } finally {
    zeroPhase.delete();
    frames.delete();
  }
  return { curve, bandNov };
}

/** hop 1024 でスペクトル統計と MFCC */
function spectralPass(es: Essentia, signal: Float32Array) {
  const frames = es.FrameGenerator(signal, FRAME, HOP_SPEC);
  const n = frames.size();
  let cSum = 0, fSum = 0, lowSum = 0, fCount = 0;
  const mSum = new Float64Array(13), mSq = new Float64Array(13);
  let prev: any = null;

  try {
    for (let i = 0; i < n; i++) {
      const frame = frames.get(i);
      const win = es.Windowing(frame, true, FRAME, 'hann');
      const specV = es.Spectrum(win.frame, FRAME).spectrum;
      cSum += es.Centroid(specV, SR_DSP / 2).centroid;
      lowSum += es.EnergyBandRatio(specV, SR_DSP, 0, 250).energyBandRatio;
      if (prev) { fSum += es.Flux(specV).flux; fCount++; }

      const mf = es.MFCC(specV, 2, 8000, SPEC_BINS, 0, 'dbamp', 0, 'unit_sum', 40, 13, SR_DSP, 1e-10, 'power', 'htkMel', 'warping');
      const c = es.vectorToArray(mf.mfcc);
      for (let j = 0; j < 13; j++) { mSum[j] += c[j]; mSq[j] += c[j] * c[j]; }
      mf.mfcc.delete(); mf.bands.delete();

      if (prev) prev.delete();
      prev = specV;
      win.frame.delete();
      frame.delete();
    }
  } finally {
    if (prev) prev.delete();
    frames.delete();
  }

  const mfccMean = new Float32Array(13), mfccVar = new Float32Array(13);
  for (let j = 0; j < 13; j++) {
    mfccMean[j] = mSum[j] / n;
    mfccVar[j] = Math.max(0, mSq[j] / n - mfccMean[j] * mfccMean[j]);
  }
  return {
    centroid: cSum / n,
    flux: fCount ? fSum / fCount : 0,
    lowEnergyRatio: lowSum / n,
    mfccMean, mfccVar,
  };
}

/** 帯域別 novelty を 16 分グリッドに畳み込む（帯域ごとに最大値で正規化） */
function foldGrid(bandNov: Float32Array[], bpm: number, tick0: number): Float32Array {
  const out = new Float32Array(GRID_BANDS.length * GRID_STEPS);
  if (!(bpm > 0)) return out;
  const step = (60 / bpm) / 4;
  const frameSec = HOP_ONSET / SR_DSP;

  for (let b = 0; b < bandNov.length; b++) {
    const sum = new Float64Array(GRID_STEPS), cnt = new Int32Array(GRID_STEPS);
    const nov = bandNov[b];
    for (let i = 0; i < nov.length; i++) {
      const t = i * frameSec - tick0;
      if (t < 0) continue;
      const s = ((Math.round(t / step) % GRID_STEPS) + GRID_STEPS) % GRID_STEPS;
      sum[s] += nov[i]; cnt[s]++;
    }
    let max = 0;
    const tmp = new Float64Array(GRID_STEPS);
    for (let s = 0; s < GRID_STEPS; s++) { tmp[s] = cnt[s] ? sum[s] / cnt[s] : 0; if (tmp[s] > max) max = tmp[s]; }
    for (let s = 0; s < GRID_STEPS; s++) out[b * GRID_STEPS + s] = max > 0 ? tmp[s] / max : 0;
  }
  return out;
}

/** 線形補間で固定長に */
function resample(src: Float32Array, len: number): Float32Array {
  const out = new Float32Array(len);
  if (src.length === 0) return out;
  if (src.length === 1) { out.fill(src[0]); return out; }
  const ratio = (src.length - 1) / (len - 1);
  for (let i = 0; i < len; i++) {
    const x = i * ratio, i0 = Math.floor(x), i1 = Math.min(src.length - 1, i0 + 1), f = x - i0;
    out[i] = src[i0] * (1 - f) + src[i1] * f;
  }
  return out;
}

export interface MultiDspFeatures extends DspFeatures {
  windowUsed: number;
  windowActivity: Float32Array;
}

/**
 * v0.3.0: 複数の窓を受け取り、
 *   - 全体統計（rms / key / MFCC など）は全窓をつないだ信号から
 *   - リズムと onset は「最も低域 novelty が活発な窓」から
 * 取る。中央 1 箇所だけを見てブレイクダウンを掴む事故を避けるため。
 */
export function extractDspMulti(es: Essentia, windows: Float32Array[]): MultiDspFeatures {
  if (windows.length === 1) {
    return { ...extractDsp(es, windows[0]), windowUsed: 0, windowActivity: Float32Array.from([1]) };
  }

  // 1) 全体統計は連結信号から（onset 系はここでは使わない）
  const total = windows.reduce((a, w) => a + w.length, 0);
  const concat = new Float32Array(total);
  let off = 0;
  for (const w of windows) { concat.set(w, off); off += w.length; }
  const global = extractDsp(es, concat, true);

  // 2) 窓ごとにリズムと onset を取り、低域 novelty が最も活発な窓を選ぶ
  const activity = new Float32Array(windows.length);
  let best = 0, bestAct = -1;
  let bestPack: { bpm: number; conf: number; ticks: Float32Array; curve: Float32Array; bandNov: Float32Array[] } | null = null;

  for (let i = 0; i < windows.length; i++) {
    const vec = es.arrayToVector(windows[i]);
    let rh: any;
    try { rh = es.RhythmExtractor2013(vec, 208, 'multifeature', 40); } finally { vec.delete(); }
    const ticks = Float32Array.from(es.vectorToArray(rh.ticks));
    rh.ticks.delete(); rh.estimates.delete(); rh.bpmIntervals.delete();
    const { curve, bandNov } = onsetPass(es, windows[i]);
    let sum = 0;
    for (let k = 0; k < bandNov[0].length; k++) sum += bandNov[0][k];
    activity[i] = bandNov[0].length ? sum / bandNov[0].length : 0;
    if (activity[i] > bestAct) {
      bestAct = activity[i];
      best = i;
      bestPack = { bpm: rh.bpm, conf: rh.confidence, ticks, curve, bandNov };
    }
  }

  const p = bestPack!;
  const bandCurves = new Float32Array(GRID_BANDS.length * BAND_CURVE_LEN);
  for (let b = 0; b < p.bandNov.length; b++) bandCurves.set(resample(p.bandNov[b], BAND_CURVE_LEN), b * BAND_CURVE_LEN);

  return {
    ...global,
    bpmMeasured: p.bpm, bpmConfidence: p.conf, beatTicks: p.ticks,
    onsetCurve: resample(p.curve, ONSET_CURVE_LEN),
    onsetGrid: foldGrid(p.bandNov, p.bpm, p.ticks.length ? p.ticks[0] : 0),
    bandCurves,
    windowUsed: best,
    windowActivity: activity,
  };
}


/**
 * v0.5.0: 走査区間の中から、解析に使う 60 秒の置き場所を選ぶ。
 *
 * **選ぶ基準は「低域(0-250Hz)のエネルギーが高いこと」。**
 * ブレイクダウンはキックが抜ける区間なので低域が落ちる。そこを避けたい。
 *
 * v0.3.0 は onset novelty で選んでいたが、それだと「一番密度が高い区間」を選ぶことになり、
 * 横ノリの曲でも最も 4 つ打ちに近い場所を選んでしまう恐れがあった（Gate 2 悪化の一因の疑い）。
 * エネルギーで選べば「音が鳴っているか」だけを見ることになり、ノリの判定に手心が入らない。
 *
 * 計算は粗く済ませる（hop 8192 = 約 0.19 秒）。ブレイクダウンは数十秒スケールなので十分。
 */
export function pickWindow(
  es: Essentia, scan: Float32Array, sampleRate: number,
): { offset: number; activity: Float32Array } {
  const winLen = Math.floor(EXCERPT_SEC * sampleRate);
  if (scan.length <= winLen) return { offset: 0, activity: Float32Array.from([1]) };

  // 低域エネルギーの粗い曲線
  const FR = 2048, HOP = 8192;
  const lowBin = Math.max(1, Math.round(250 / (sampleRate / 2) * (FR / 2)));
  const nFrames = Math.floor((scan.length - FR) / HOP) + 1;
  const energy = new Float64Array(Math.max(0, nFrames));
  const frame = new Float32Array(FR);
  for (let i = 0; i < nFrames; i++) {
    frame.set(scan.subarray(i * HOP, i * HOP + FR));
    const v = es.arrayToVector(frame);
    let win: any, spec;
    try { win = es.Windowing(v, true, FR, 'hann'); spec = es.Spectrum(win.frame); } finally { v.delete(); win?.frame.delete(); }
    const arr = es.vectorToArray(spec.spectrum);
    let e = 0;
    for (let b = 0; b <= lowBin && b < arr.length; b++) e += arr[b] * arr[b];
    spec.spectrum.delete();
    energy[i] = e;
  }

  // 60 秒窓を WINDOW_HOP_SEC ごとにずらして、低域エネルギーの平均が最大の位置を選ぶ
  const framesPerWin = Math.floor(winLen / HOP);
  const framesPerHop = Math.max(1, Math.floor(WINDOW_HOP_SEC * sampleRate / HOP));
  const cand = [];
  for (let f = 0; f + framesPerWin <= energy.length; f += framesPerHop) {
    let sum = 0;
    for (let k = f; k < f + framesPerWin; k++) sum += energy[k];
    cand.push({ sample: f * HOP, act: sum / framesPerWin });
  }
  if (!cand.length) return { offset: 0, activity: Float32Array.from([1]) };
  let best = cand[0];
  for (const c of cand) if (c.act > best.act) best = c;
  const offset = Math.min(best.sample, scan.length - winLen);
  return { offset, activity: Float32Array.from(cand.map((c) => c.act)) };
}

/** v0.5.0 の入口。走査信号から 60 秒を選び、その区間で全特徴量を取る */
export function extractDspScan(
  es: Essentia, scan: Float32Array, sampleRate: number,
): DspFeatures & { windowOffsetSamples: number; windowActivity: Float32Array } {
  const { offset, activity } = pickWindow(es, scan, sampleRate);
  const winLen = Math.min(Math.floor(EXCERPT_SEC * sampleRate), scan.length - offset);
  const window = scan.subarray(offset, offset + winLen);
  return { ...extractDsp(es, window), windowOffsetSamples: offset, windowActivity: activity };
}
