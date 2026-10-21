// v0.5.0 の窓選びが本当にブレイクダウンを避けるかを、合成音で確かめる。音源は要らない。
//
// なぜ要るか: 窓の置き場所を決めるのは Gate 2 の結果を左右する中核の処理なのに、
// 本物の音源が Windows にしか無いため、Mac では実データで確かめられない。
// 「低域が抜けている区間を避ける」という 1 点だけなら合成音で検証できる。
//
//   node packages/analyzer/src/selftest-window.ts

import { createEssentia, pickWindow } from './features.ts';
import { EXCERPT_SEC, SR_DSP } from './types.ts';

/**
 * テスト信号を作る。長さ totalSec 秒。
 * 全体に薄いノイズ、そのうえに 128BPM のキック（50Hz）を置く。
 * breakdown で指定した区間だけキックを抜く（＝低域が落ちる）。
 */
function makeSignal(totalSec: number, breakdown: [number, number]): Float32Array {
  const n = totalSec * SR_DSP;
  const sig = new Float32Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) sig[i] = rnd() * 0.05;            // 薄いノイズ（全帯域）

  const beat = 60 / 128;                                        // 128 BPM
  for (let t = 0; t < totalSec; t += beat) {
    if (t >= breakdown[0] && t < breakdown[1]) continue;         // ここはキックを置かない
    const start = Math.floor(t * SR_DSP);
    const len = Math.floor(0.12 * SR_DSP);
    for (let k = 0; k < len && start + k < n; k++) {
      const env = Math.exp(-k / (0.03 * SR_DSP));
      sig[start + k] += Math.sin(2 * Math.PI * 50 * k / SR_DSP) * env * 0.8;
    }
  }
  return sig;
}

const es = createEssentia();
let failed = 0;

const cases: { name: string; total: number; breakdown: [number, number] }[] = [
  { name: '中央がブレイクダウン（v0.3.0 が想定していた事故）', total: 180, breakdown: [60, 120] },
  { name: '前半がブレイクダウン', total: 180, breakdown: [0, 60] },
  { name: '後半がブレイクダウン', total: 180, breakdown: [120, 180] },
  { name: 'ブレイクダウン無し（どこでもよい）', total: 180, breakdown: [-1, -1] },
];

for (const c of cases) {
  const sig = makeSignal(c.total, c.breakdown);
  const { offset, activity } = pickWindow(es, sig, SR_DSP);
  const startSec = offset / SR_DSP;
  const endSec = startSec + EXCERPT_SEC;
  // 選んだ 60 秒がブレイクダウンとどれだけ重なっているか
  const ov = Math.max(0, Math.min(endSec, c.breakdown[1]) - Math.max(startSec, c.breakdown[0]));
  const ok = c.breakdown[0] < 0 ? true : ov <= 10;              // 10 秒までは許容（刻みが 10 秒のため）
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'NG  '}${c.name}`);
  console.log(`      選んだ区間 ${startSec.toFixed(0)}-${endSec.toFixed(0)}秒 / ` +
    `ブレイクダウンとの重なり ${ov.toFixed(0)}秒 / 候補 ${activity.length} 箇所`);
}

console.log(failed ? `\n${failed} 件 NG。窓選びが壊れています` : '\nすべて OK。低域が抜けている区間を避けられています');
process.exit(failed ? 1 : 0);
