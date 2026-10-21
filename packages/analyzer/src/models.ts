// musicnn embedding + danceability / emomusic ヘッド。docs/FEATURE_SPEC.md §4.5 の実装。
// モデルは vendor/models/ の同梱物のみを読む（配布元 zip が壊れているため。DECISIONS.md Gate 0 追記）。

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tf from '@tensorflow/tfjs';
import * as tfwasm from '@tensorflow/tfjs-backend-wasm';
import { EMBEDDING_DIM, TAGGRAM_DIM } from './types.ts';

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
export const MODELS_DIR = join(HERE, '..', '..', '..', 'vendor', 'models');

const PATCH = 187;
const BANDS = 96;

function fileHandler(dir: string): tf.io.IOHandler {
  return {
    load: async () => {
      const j = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));
      const bufs: Buffer[] = j.weightsManifest[0].paths.map((f: string) => readFileSync(join(dir, f)));
      const total = bufs.reduce((a, b) => a + b.length, 0);
      const merged = new Uint8Array(total);
      let o = 0;
      for (const b of bufs) { merged.set(new Uint8Array(b), o); o += b.length; }
      return {
        modelTopology: j.modelTopology,
        weightSpecs: j.weightsManifest.flatMap((g: any) => g.weights),
        weightData: merged.buffer,
        format: j.format, generatedBy: j.generatedBy, convertedBy: j.convertedBy,
        signature: j.signature, userDefinedMetadata: j.userDefinedMetadata,
      } as tf.io.ModelArtifacts;
    },
  };
}

export interface ModelBundle {
  musicnn: tf.GraphModel;
  danceability: tf.GraphModel;
  emomusic: tf.GraphModel;
  backend: string;
}

export async function loadModels(modelsDir = MODELS_DIR): Promise<ModelBundle> {
  // WASM backend を明示指定する。指定しないと純 JS CPU に落ちて 10 倍遅くなる
  const wasmDir = dirname(require_.resolve('@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm'));
  tfwasm.setWasmPaths(wasmDir + '/');
  await tf.setBackend('wasm');
  await tf.ready();
  if (tf.getBackend() !== 'wasm') {
    throw new Error(`tfjs backend が wasm になりません (現在: ${tf.getBackend()})。処理が 10 倍遅くなるため停止します。`);
  }
  return {
    musicnn: await tf.loadGraphModel(fileHandler(join(modelsDir, 'msd-musicnn-1'))),
    danceability: await tf.loadGraphModel(fileHandler(join(modelsDir, 'danceability-msd-musicnn-1'))),
    emomusic: await tf.loadGraphModel(fileHandler(join(modelsDir, 'emomusic-msd-musicnn-1'))),
    backend: tf.getBackend(),
  };
}

export interface ModelFeatures {
  embedding: Float32Array;
  taggram: Float32Array;
  valence: number;
  arousal: number;
  danceabilityMl: number;
  /**
   * danceability ヘッドの softmax の手前（class0 - class1）。
   * softmax 出力（danceabilityMl）はクラブ音源だと全曲 0.99-1.00 に張り付いて使えない。
   * モデルの不具合ではなく、収録が全部ダンス音楽だから「踊れる」と断言されるだけ。
   * 手前の値は 4.4-14.6 に広がっていて曲の区別が付く。solver が使うのはこちら。
   */
  danceabilityLogit: number;
  patches: number;
}

/** melPatches: TensorflowInputMusiCNN の出力を 187 フレームごとに並べた [nPatch*187*96] */
export async function runModels(m: ModelBundle, mel: Float32Array, nPatch: number): Promise<ModelFeatures> {
  const x = tf.tensor3d(mel, [nPatch, PATCH, BANDS]);
  const isTraining = tf.scalar(false, 'bool');   // batch-norm の training フラグ。渡さないと落ちる
  const outs = m.musicnn.execute(
    { 'model/Placeholder': x, 'model/Placeholder_1': isTraining },
    ['model/dense/Relu', 'model/Sigmoid'],
  ) as tf.Tensor[];
  const [embRaw, tags] = outs;
  const emb = embRaw.mean(0);
  const tagMean = tags.mean(0);

  // softmax と、その手前（logit）の両方を取る。softmax は飽和して使えないため
  const [dOut, dPre] = m.danceability.execute(
    emb.reshape([1, EMBEDDING_DIM]), ['model/Softmax', 'model/dense_1/BiasAdd']) as tf.Tensor[];
  const eOut = m.emomusic.execute(emb.reshape([1, 1, EMBEDDING_DIM]), ['dense_out']) as tf.Tensor;

  const embedding = Float32Array.from(await emb.data());
  const taggram = Float32Array.from(await tagMean.data());
  const d = await dOut.data();
  const dp = await dPre.data();
  const e = await eOut.data();

  tf.dispose([x, isTraining, embRaw, tags, emb, tagMean, dOut, dPre, eOut]);

  if (embedding.length !== EMBEDDING_DIM) throw new Error(`embedding 次元が ${embedding.length} です（期待 ${EMBEDDING_DIM}）`);
  if (taggram.length !== TAGGRAM_DIM) throw new Error(`taggram 次元が ${taggram.length} です（期待 ${TAGGRAM_DIM}）`);

  return {
    embedding, taggram,
    danceabilityMl: d[0], danceabilityLogit: dp[0] - dp[1],
    valence: e[0], arousal: e[1], patches: nPatch,
  };
}

/** essentia の TensorflowInputMusiCNN でパッチを作る（16kHz, frame 512 / hop 256） */
export function buildMelPatches(es: any, signal16k: Float32Array): { mel: Float32Array; nPatch: number } {
  const frames = es.FrameGenerator(signal16k, 512, 256);
  const rows: Float32Array[] = [];
  try {
    for (let i = 0; i < frames.size(); i++) {
      const frame = frames.get(i);
      const b = es.TensorflowInputMusiCNN(frame);
      rows.push(Float32Array.from(es.vectorToArray(b.bands)));
      b.bands.delete();
      frame.delete();
    }
  } finally {
    frames.delete();
  }
  // 3 秒未満の音源は 1 パッチに満たない。無人実行で落とさないためゼロ詰めして 1 パッチにする
  const nPatch = Math.max(1, Math.floor(rows.length / PATCH));
  const mel = new Float32Array(nPatch * PATCH * BANDS);
  const usable = Math.min(rows.length, nPatch * PATCH);
  for (let i = 0; i < usable; i++) mel.set(rows[i], i * BANDS);
  return { mel, nPatch };
}
