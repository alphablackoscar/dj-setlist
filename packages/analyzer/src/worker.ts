// 解析ワーカー。親から 1 曲ずつ受け取り、結果を返す。
// 子プロセスにしているのは、1 曲の異常終了で全体を巻き込まないため（一晩の無人実行が前提）。

import { existsSync } from 'node:fs';
import { decodeAt, decodeScan, probeDuration } from './decode.ts';
import { createEssentia, extractDspScan } from './features.ts';
import { buildMelPatches, loadModels, runModels, type ModelBundle } from './models.ts';
import { EXCERPT_SEC, SR_DSP, SR_MODEL, type Features, type JobResult, type XmlTrack } from './types.ts';

let es: any = null;
let models: ModelBundle | null = null;

async function init(modelsDir?: string): Promise<void> {
  es = createEssentia();
  models = await loadModels(modelsDir);
}

async function analyze(track: XmlTrack): Promise<Features> {
  if (!existsSync(track.path)) throw Object.assign(new Error(`ファイルが見つかりません: ${track.path}`), { skipped: true });

  const duration = await probeDuration(track.path);

  // v0.5.0: 1) 長めに 1 回デコードして 60 秒の置き場所を決める
  const { signal: scan44, scanStart } = await decodeScan(track.path, SR_DSP, duration);
  const dsp = extractDspScan(es, scan44, SR_DSP);
  const windowStartSec = scanStart + dsp.windowOffsetSamples / SR_DSP;

  // 2) 決まった位置の同じ 60 秒をモデル用に 16kHz で取り直す（DSP と同じ区間を見る）
  const sig16 = await decodeAt(track.path, SR_MODEL, windowStartSec, EXCERPT_SEC);
  const { mel, nPatch } = buildMelPatches(es, sig16);
  const ml = await runModels(models!, mel, nPatch);

  return {
    duration, windowStart: windowStartSec, windowActivity: dsp.windowActivity,
    bpmMeasured: dsp.bpmMeasured, bpmConfidence: dsp.bpmConfidence, beatCount: dsp.beatTicks.length,
    key: dsp.key, scale: dsp.scale, keyStrength: dsp.keyStrength,
    rms: dsp.rms, spectralCentroid: dsp.spectralCentroid, flux: dsp.flux,
    lowEnergyRatio: dsp.lowEnergyRatio, zcr: dsp.zcr, danceabilityDsp: dsp.danceabilityDsp,
    valence: ml.valence, arousal: ml.arousal, danceabilityMl: ml.danceabilityMl, danceabilityLogit: ml.danceabilityLogit,
    onsetCurve: dsp.onsetCurve, bandCurves: dsp.bandCurves, onsetGrid: dsp.onsetGrid, beatTicks: dsp.beatTicks,
    mfccMean: dsp.mfccMean, mfccVar: dsp.mfccVar,
    embedding: ml.embedding, taggram: ml.taggram,
  };
}

/** Float32Array は IPC で普通のオブジェクトになるため、明示的に配列へ落として送る */
function serialize(f: Features): any {
  return {
    ...f,
    onsetCurve: Array.from(f.onsetCurve), bandCurves: Array.from(f.bandCurves), onsetGrid: Array.from(f.onsetGrid),
    windowActivity: Array.from(f.windowActivity),
    beatTicks: Array.from(f.beatTicks), mfccMean: Array.from(f.mfccMean),
    mfccVar: Array.from(f.mfccVar), embedding: Array.from(f.embedding),
    taggram: Array.from(f.taggram),
  };
}

process.on('message', async (msg: any) => {
  try {
    if (msg.type === 'init') {
      await init(msg.modelsDir);
      process.send!({ type: 'ready' });
      return;
    }
    if (msg.type === 'job') {
      const t0 = Date.now();
      const track: XmlTrack = msg.track;
      try {
        const features = await analyze(track);
        process.send!({ type: 'result', result: { ok: true, track, features: serialize(features), ms: Date.now() - t0 } });
      } catch (e: any) {
        const status = e?.skipped ? 'skipped' : 'error';
        process.send!({ type: 'result', result: { ok: false, track, status, error: String(e?.message ?? e), ms: Date.now() - t0 } as JobResult });
      }
      return;
    }
    if (msg.type === 'bye') process.exit(0);
  } catch (e: any) {
    process.send!({ type: 'fatal', error: String(e?.stack ?? e) });
    process.exit(1);
  }
});
