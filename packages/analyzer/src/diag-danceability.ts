// danceability_ml が全曲 0.99-1.00 に飽和している件の調査。
//
// **音源には触らない。** DB に保存済みの embedding だけを読んでヘッドを回し直す。
// FEATURE_SPEC の P1（生の特徴量だけを保存する）が効いていて、音源なしで再現できる。
//
//   node packages/analyzer/src/diag-danceability.ts [--db data/features.db]

import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tf from '@tensorflow/tfjs';
import { loadModels } from './models.ts';
import { EMBEDDING_DIM } from './types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const dbPath = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : join(ROOT, 'data/features.db');

const f32 = (b: Uint8Array): Float32Array => {
  const c = b.slice();
  return new Float32Array(c.buffer, c.byteOffset, c.byteLength / 4);
};
const quantiles = (v: number[]): string => {
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return `min ${q(0).toFixed(4)}  p25 ${q(0.25).toFixed(4)}  p50 ${q(0.5).toFixed(4)}  p75 ${q(0.75).toFixed(4)}  max ${q(0.999).toFixed(4)}`;
};

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare(`
  SELECT basename, genre, danceability_ml, danceability_dsp, taggram, embedding
  FROM tracks WHERE status = 'done' AND embedding IS NOT NULL`).all() as any[];
db.close();
console.log(`${dbPath}: ${rows.length} 曲\n`);

const m = await loadModels();

interface Row { name: string; genre: string; stored: number; dsp: number; c0: number; c1: number; logit: number; emb: Float32Array; }
const out: Row[] = [];
for (const r of rows) {
  const emb = f32(r.embedding);
  const t = tf.tensor(emb, [1, EMBEDDING_DIM]);
  const [soft, pre] = m.danceability.execute(t, ['model/Softmax', 'model/dense_1/BiasAdd']) as tf.Tensor[];
  const s = await soft.data();
  const p = await pre.data();
  tf.dispose([t, soft, pre]);
  out.push({
    name: String(r.basename), genre: String(r.genre ?? ''),
    stored: Number(r.danceability_ml), dsp: Number(r.danceability_dsp),
    c0: s[0], c1: s[1], logit: p[0] - p[1], emb,
  });
}

console.log('--- 1. softmax の 2 クラス ---');
console.log('  class0 (DB に保存している値):', quantiles(out.map((x) => x.c0)));
console.log('  class1                     :', quantiles(out.map((x) => x.c1)));
console.log('  保存値の再現:', out.every((x) => Math.abs(x.c0 - x.stored) < 1e-4) ? 'OK（DB の値と一致）' : '一致しない');

console.log('\n--- 2. softmax の手前（logit 差 = class0 - class1）---');
console.log('  ' + quantiles(out.map((x) => x.logit)));
console.log('  softmax は差が 5 を超えると 0.993 以上に張り付く。順位が残っているかはここで分かる');

console.log('\n--- 3. 入力（embedding）が壊れていないか ---');
const dims = EMBEDDING_DIM;
const colVar = new Float64Array(dims), colMean = new Float64Array(dims);
for (const x of out) for (let i = 0; i < dims; i++) colMean[i] += x.emb[i] / out.length;
for (const x of out) for (let i = 0; i < dims; i++) colVar[i] += (x.emb[i] - colMean[i]) ** 2 / out.length;
const dead = [...colVar].filter((v) => v < 1e-9).length;
console.log(`  次元ごとの平均: ${quantiles([...colMean])}`);
console.log(`  曲間で動かない次元: ${dead}/${dims}`);
const norm = (a: Float32Array) => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s) || 1; };
const cos: number[] = [];
for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
  let d = 0; for (let k = 0; k < dims; k++) d += out[i].emb[k] * out[j].emb[k];
  cos.push(d / (norm(out[i].emb) * norm(out[j].emb)));
}
console.log(`  曲どうしの cosine 類似度: ${quantiles(cos)}`);
console.log('  （1.00 に張り付いていたら embedding 自体が曲を区別できていない = 音色距離も無意味）');

console.log('\n--- 4. logit で並べた両端 ---');
const sorted = [...out].sort((a, b) => a.logit - b.logit);
const show = (x: Row) => `  logit ${x.logit.toFixed(2).padStart(7)}  softmax ${x.c0.toFixed(6)}  dsp ${x.dsp.toFixed(2)}  ${x.genre.slice(0, 18).padEnd(18)} ${x.name.slice(0, 40)}`;
console.log('  低い順 5:'); for (const x of sorted.slice(0, 5)) console.log(show(x));
console.log('  高い順 5:'); for (const x of sorted.slice(-5)) console.log(show(x));

console.log('\n--- 5. logit と DSP 版 danceability の順位相関 ---');
const rank = (v: number[]) => { const idx = v.map((x, i) => [x, i] as [number, number]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); idx.forEach(([, i], k) => r[i] = k); return r; };
const rl = rank(out.map((x) => x.logit)), rd = rank(out.map((x) => x.dsp));
const nn = out.length;
let d2 = 0; for (let i = 0; i < nn; i++) d2 += (rl[i] - rd[i]) ** 2;
console.log(`  Spearman = ${(1 - 6 * d2 / (nn * (nn * nn - 1))).toFixed(3)}  （2 つが別物を測っているなら 0 に近い）`);
