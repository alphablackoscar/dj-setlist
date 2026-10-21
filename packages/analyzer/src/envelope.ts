// 曲まるごとの音量の起伏を取る。仕様は docs/FEATURE_SPEC.md §4.7。
//
// **既存の解析とは完全に別のパス**。モデルも essentia も使わず ffmpeg と算術だけ。
// 既存の特徴量には触れないので ANALYZER_VERSION は上がらない（ENVELOPE_VERSION が別にある）。
//
// 取るのは 2 本だけ:
//   rms — 全帯域の音量。盛り上がりの形
//   low — 0-250Hz の音量。**キックが抜けているか**が分かる
// ビルドアップは「low が落ちたまま rms が上がり続け、最後に low が一気に戻る」形をしている。
// その判定自体はここではやらない（重みが変わるため solver 側で計算する。Hard Constraint 3）。

import { spawn } from 'node:child_process';
import { ENV_LOW_HZ, ENV_POINTS, ENV_SR, type Envelope } from './types.ts';

/** 曲全体を mono ENV_SR で展開する。頭出しをしないので seek のコストが無く 350-700 倍速で流れる */
function decodeWhole(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(ENV_SR), '-f', 'f32le', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg デコード失敗: ${err.trim().slice(0, 200)}`));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.byteLength / 4);
      if (n < ENV_SR) return reject(new Error(`デコード結果が短すぎます (${n} samples)`));
      // Buffer の byteOffset が 4 の倍数とは限らないため確実にコピーする（既知の地雷）
      const copy = new ArrayBuffer(n * 4);
      new Uint8Array(copy).set(new Uint8Array(buf.buffer, buf.byteOffset, n * 4));
      resolve(new Float32Array(copy));
    });
  });
}

/**
 * 2 次のローパス（RBJ cookbook）。0-ENV_LOW_HZ だけを残す。
 * FFT を使わないのは、必要なのが帯域の**音量の推移**だけで分解能が要らないため。
 */
function lowpass(x: Float32Array, cutoffHz: number, sr: number): Float32Array {
  const w0 = (2 * Math.PI * cutoffHz) / sr;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const alpha = sin / (2 * Math.SQRT1_2);          // Q = 1/sqrt(2)（バターワース）
  const a0 = 1 + alpha;
  const b0 = ((1 - cos) / 2) / a0, b1 = (1 - cos) / a0, b2 = b0;
  const a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;

  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
  }
  return y;
}

/** 信号を ENV_POINTS 個の区間に等分し、各区間の RMS を返す */
function bucketRms(x: Float32Array): Float32Array {
  const out = new Float32Array(ENV_POINTS);
  for (let k = 0; k < ENV_POINTS; k++) {
    const a = Math.floor((k * x.length) / ENV_POINTS);
    const b = Math.floor(((k + 1) * x.length) / ENV_POINTS);
    let s = 0;
    for (let i = a; i < b; i++) s += x[i] * x[i];
    out[k] = b > a ? Math.sqrt(s / (b - a)) : 0;
  }
  return out;
}

export async function computeEnvelope(file: string): Promise<Envelope> {
  const sig = await decodeWhole(file);
  return {
    duration: sig.length / ENV_SR,
    rms: bucketRms(sig),
    low: bucketRms(lowpass(sig, ENV_LOW_HZ, ENV_SR)),
  };
}
