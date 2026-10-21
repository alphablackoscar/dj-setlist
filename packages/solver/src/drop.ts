// ドロップの落差。**この式はここにしか置かない。**
//
// 判定スクリプトと solver で別々に実装すると必ずずれる
// （Gate 2 で窓長を決め打ちして 3 倍ずれた前例がある）。solver も
// scripts/s5-solver/drop-contrast.js もここを import すること。
//
// 入力は features.db の env_rms / env_low（FEATURE_SPEC §4.7）。
// **導出値なので DB には書かない**（Hard Constraint 3）。しきい値が変われば計算し直すだけ。

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * 「静かなブレイクから一気に爆発する」落差を dB で返す。曲中で最大の 1 箇所を取る。
 *
 * 探し方:
 *   1. 直前 16 秒の低域が全体の中央値の 60% 未満（= キックが抜けている = ビルド中）
 *   2. 直後 8 秒で低域が中央値の 90% 以上に戻る（= ドロップした）
 *   3. その 2 点の音量差を dB で測る
 *
 * dB（比の対数）にしてあるのでマスタリングの音量差は打ち消える。
 * 落差が小さい = 終始おなじ音量で鳴っている = 浅い時間でも使いやすい、と読む。
 *
 * @returns 落差(dB) と、それが起きる位置(秒)。山が見つからなければ db=0
 */
export function dropContrast(
  rms: Float32Array, low: Float32Array, duration: number,
): { db: number; atSec: number } {
  const n = rms.length;
  if (n < 8 || low.length !== n || !(duration > 0)) return { db: 0, atSec: 0 };
  const secPerPt = duration / n;
  const W = Math.max(3, Math.round(16 / secPerPt));   // ビルドとみなす長さ
  const A = Math.max(2, Math.round(8 / secPerPt));    // ドロップ後に見る長さ
  const lowRef = median(Array.from(low).filter((x) => x > 0));
  if (!(lowRef > 0)) return { db: 0, atSec: 0 };

  // **曲頭は見ない。** イントロの立ち上がり（無音 -> 本編）を最大のドロップとして拾ってしまう。
  // 実測で R&B の曲が 40dB で 1 位に来たが、位置は 17 秒でイントロだった。
  const skip = Math.max(W, Math.round(30 / secPerPt));
  // **無音を底にしない。** 底が 0 に近いと dB が発散する。曲全体の中央値の 1% で下限を切る
  const rmsRef = median(Array.from(rms).filter((x) => x > 0));
  const floorMin = Math.max(rmsRef * 0.01, 1e-6);

  // **絞り込みは累積和で O(1) にする。** 毎点で中央値を取り直すと 3970 曲で 38 秒かかり、
  // solver 1 回が 2.3 秒 -> 38 秒に悪化した（実測）。絞り込みは平均で足りる（しきい値判定なので）。
  // 中央値は、通過したわずかな点で落差を測るときだけ使う。
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + low[i];
  const meanLow = (a: number, b: number) => (cum[b] - cum[a]) / (b - a);

  let best = 0, at = 0;
  for (let d = skip; d + A < n; d++) {
    if (meanLow(d - W, d) > lowRef * 0.6) continue;      // まだ低域が抜けていない
    if (meanLow(d, d + A) < lowRef * 0.9) continue;      // 低域が戻っていない

    // ビルドの底 = 直前 16 秒のうち静かな方 1/3 の代表値。単発の谷に引っ張られないように
    const quiet = Array.from(rms.subarray(d - W, d)).sort((a, b) => a - b);
    const floor = Math.max(median(quiet.slice(0, Math.max(1, Math.floor(W / 3)))), floorMin);
    const peak = median(Array.from(rms.subarray(d, d + A)));
    const gap = 20 * Math.log10(Math.max(peak, 1e-9) / floor);
    if (gap > best) { best = gap; at = d * secPerPt; }
  }
  return { db: best, atSec: at };
}

/** node:sqlite の BLOB を Float32Array に。byteOffset が 4 の倍数とは限らないので必ずコピーする */
export function toF32(b: unknown): Float32Array | null {
  if (!b) return null;
  const c = Buffer.from(b as Uint8Array);
  return new Float32Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.length));
}
