// 縦ノリ度の計算。scripts/s2-select/gate2-judge.js で Gate 2 の判定に使った指標をそのまま使う。
//
// 重要: この値は DB に保存しない（Project Hard Constraint 3）。
// DB にあるのは band_curves（帯域別の novelty 曲線）と beat_ticks（拍位置）だけで、
// 指標の定義を変えても音源に触らずに再計算できる。S6 で定義が変わってもここを直すだけで済む。
//
// 指標: 低域(0-250Hz) の novelty を拍ごとにローカル分割して 16 分グリッドに畳み、
//       位相不変の「4 分周期の強さ」を取る。キックが何ステップ目に落ちても検出できる。

const STEPS = 16;
export const BAND_LEN = 512;   // FEATURE_SPEC §3 band_curves は 4 帯域 x 512
export const N_BANDS = 4;

/**
 * BLOB -> Float32Array。node:sqlite が返す Uint8Array は byteOffset が 4 の倍数とは限らないため、
 * 必ずコピーしてから読む（アライメント違反で TypeError になる）。1 曲 5.5KB なので実害はない。
 */
export function f32(b: Uint8Array | null | undefined): Float32Array | null {
  if (!b || b.byteLength < 4) return null;
  const copy = b.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

const mean = (a: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : 0;
};

/** 拍ごとにローカル分割して 16 分グリッドを作る（テンポ揺れとグローバル BPM のドリフトを排除） */
export function foldByTicks(curve: ArrayLike<number>, excerptSec: number, ticks: Float32Array): number[] {
  const dt = excerptSec / (curve.length - 1);
  const sum = new Float64Array(STEPS), cnt = new Int32Array(STEPS);
  for (let b = 0; b + 1 < ticks.length; b++) {
    const t0 = ticks[b], dur = ticks[b + 1] - t0;
    if (dur <= 0.15 || dur > 2) continue;              // 検出ミスの拍を捨てる
    for (let s = 0; s < 4; s++) {
      const a = t0 + dur * s / 4, z = t0 + dur * (s + 1) / 4;
      let acc = 0, n = 0;
      for (let i = Math.max(0, Math.ceil(a / dt)); i <= Math.min(curve.length - 1, Math.floor(z / dt)); i++) { acc += curve[i]; n++; }
      if (n) { const idx = (b % 4) * 4 + s; sum[idx] += acc / n; cnt[idx]++; }
    }
  }
  const g = Array.from({ length: STEPS }, (_, s) => (cnt[s] ? sum[s] / cnt[s] : 0));
  const mx = Math.max(...g) || 1;
  return g.map((v) => v / mx);
}

/** 位相不変の 4 分周期の強さ。1.0 が「4 分の位置と他の位置に差が無い」＝横ノリ寄り */
export function quarterStrength(g: number[]): number {
  const avg = mean(g) || 1e-9;
  let best = 0;
  for (let p = 0; p < 4; p++) best = Math.max(best, mean([0, 4, 8, 12].map((k) => g[(p + k) % STEPS])));
  return best / avg;
}

/** 8 分裏（4 分の中間）の強さ。ハネ・食い込みの指標 */
export function offbeatStrength(g: number[]): number {
  const avg = mean(g) || 1e-9;
  let bestP = 0, best = -1;
  for (let p = 0; p < 4; p++) { const v = mean([0, 4, 8, 12].map((k) => g[(p + k) % STEPS])); if (v > best) { best = v; bestP = p; } }
  return mean([2, 6, 10, 14].map((k) => g[(bestP + k) % STEPS])) / avg;
}

/**
 * 1 曲の縦ノリ度（生値）。大きいほど縦ノリ。band_curves と beat_ticks が無ければ null。
 *
 * **指標は低域(0-250Hz)の 8 分裏の強さを反転したもの。**
 * 4 つ打ちは低域が拍の上に乗り、裏に食い込まない。横ノリ（ヒップホップ・ブロークン）は
 * 低域が裏に食い込む。Gate 2 の実測でも、この向きで最も分かれた（v0.5.0 / 分離度 0.32）。
 *
 * ただし **0.32 は基準 0.40 に届いておらず、弱い指標**（docs/DECISIONS.md）。
 * solver では `config/weights.json` の `groove_target` を低く設定して補助的にだけ使う。
 * DB には曲線しか無いので、より良い指標が見つかれば音源なしでここを差し替えられる。
 *
 * 窓の長さは beat_ticks から導く（analyzer の窓長が変わっても追随するように。
 * バージョン決め打ちで 2 度ずれた。docs/DECISIONS.md 参照）。
 */
export function grooveRaw(bandCurves: Float32Array | null, beatTicks: Float32Array | null, duration: number | null): number | null {
  if (!bandCurves || !beatTicks || bandCurves.length < BAND_LEN || beatTicks.length < 8) return null;
  const low = bandCurves.subarray(0, BAND_LEN);          // 帯域 0 = 0-250Hz（キック）
  const span = beatTicks[beatTicks.length - 1] - beatTicks[0];
  const excerpt = beatTicks[beatTicks.length - 1] + span / (beatTicks.length - 1);
  return -offbeatStrength(foldByTicks(low, excerpt, beatTicks));
}
