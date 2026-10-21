// CLI。XML を読み、ワーカーに配り、1 曲ごとに features.db へ書く。
// 使い方は packages/analyzer/README.md、仕様は docs/FEATURE_SPEC.md。

import { fork, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTools } from './decode.ts';
import { FeatureStore, trackKey } from './db.ts';
import { computeEnvelope } from './envelope.ts';
import { MODELS_DIR } from './models.ts';
import { parseCollection } from './xml.ts';
import { ANALYZER_VERSION, ENV_POINTS, type Features, type XmlTrack } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'worker.ts');

interface Args {
  xml: string; db: string; limit: number | null; workers: number;
  only: string | null; audioRootFrom: string | null; audioRootTo: string | null;
  check: boolean; force: boolean; refreshMeta: boolean; envelope: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const root = get('audio-root');
  return {
    xml: get('xml') ?? 'data/collection.xml',
    db: get('db') ?? 'data/features.db',
    limit: get('limit') ? Number(get('limit')) : null,
    workers: get('workers') ? Number(get('workers')) : Math.max(1, Math.min(4, cpus().length - 1)),
    only: get('only'),
    audioRootFrom: get('audio-root-from'),
    audioRootTo: root ?? get('audio-root-to'),
    check: has('check'),
    force: has('force'),
    refreshMeta: has('refresh-meta'),
    envelope: has('envelope'),
  };
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`analyzer ${ANALYZER_VERSION}  node ${process.version}  platform ${process.platform}`);
  await checkTools();
  console.log('ffmpeg / ffprobe: OK');
  if (!existsSync(MODELS_DIR)) throw new Error(`モデルが見つかりません: ${MODELS_DIR}\nリポジトリを clone し直してください（vendor/models/ が必要です）。`);
  console.log(`models: ${MODELS_DIR}`);

  if (args.check) { console.log('--check のためここで終了します。環境は問題ありません。'); return; }

  if (!existsSync(args.xml)) {
    throw new Error(`XML が見つかりません: ${args.xml}\n` +
      `rekordbox から書き出して data/collection.xml に置いてください（docs/WINDOWS_START.md 参照）。`);
  }

  let tracks = parseCollection(resolve(args.xml), {
    audioRootFrom: args.audioRootFrom ?? undefined,
    audioRootTo: args.audioRootTo ?? undefined,
  });
  console.log(`XML: ${tracks.length} 曲`);

  if (args.only) {
    const wanted = new Set(readFileSync(args.only, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    tracks = tracks.filter((t) => wanted.has(t.basename));
    console.log(`--only: ${tracks.length} 曲に絞り込み`);
  }

  const store = new FeatureStore(resolve(args.db));

  // --- --refresh-meta: 音を解析し直さず、XML のメタデータだけ DB に反映して終わる ---
  //
  // 通常の実行は解析済みの曲を飛ばすので、**あとから rekordbox でジャンルを埋めても
  // features.db は古いまま**になる。空欄のジャンルを埋めていく運用に必要。
  if (args.refreshMeta) {
    const r = store.refreshMeta(tracks);
    console.log(`メタデータを更新しました: ${r.updated} 曲を書き換え / ${tracks.length - r.notFound - r.updated} 曲は変更なし` +
      (r.notFound ? ` / ${r.notFound} 曲はまだ解析されていません（通常実行で解析されます）` : ''));
    console.log('※ 音は解析し直していません。特徴量と analyzer_version はそのままです。');
    store.close();
    return;
  }

  // --- --envelope: 曲まるごとの音量の起伏だけを取る（FEATURE_SPEC §4.7）---
  //
  // 既存の特徴量はすべて 60 秒窓の中の値で、しかもその窓は「低域エネルギーが最大の 60 秒」
  // として選んである。ビルドアップは構造的にその外にあるので、既存の値からは判定できない。
  // モデルを使わず ffmpeg と算術だけなので速い（実測 0.66 秒/曲）。
  // **既存の特徴量と analyzer_version には触らない。**
  if (args.envelope) {
    const byKey = new Map(tracks.map((t) => [trackKey(t.size, t.basename), t]));
    let targets = store.envelopeTargets(args.force);
    if (args.limit) targets = targets.slice(0, args.limit);
    console.log(`起伏の対象: ${targets.length} 曲 / 並列 ${args.workers}` +
      (args.force ? '（--force なので取得済みも取り直します）' : '（取得済みは飛ばします）'));
    if (targets.length === 0) { console.log('やることがありません。'); store.close(); return; }

    const t0 = Date.now();
    let done = 0, ok = 0, failed = 0;
    const queue = [...targets];
    const worker = async (): Promise<void> => {
      for (;;) {
        const t = queue.shift();
        if (!t) return;
        const xt = byKey.get(trackKey(t.size, t.basename));
        // **数えるのは終わってから。** 着手時に数えると、並列数だけ先に進んで
        // 4 曲とも [4/4] になる（実際にそうなった）。画面の進捗バーが飛ぶ。
        // **1 曲ごとに `[n/total]` を出す。** 通常の解析と同じ形にしてあるので、
        // 画面（packages/app）が同じ正規表現で進捗を拾える。出さないとバーが止まって見える。
        if (!xt) { failed++; console.log(`[${++done}/${targets.length}] SKIP ${t.basename.slice(0, 48)} XML に無い`); continue; }
        try {
          const env = await computeEnvelope(xt.path);
          store.saveEnvelope(t.size, t.basename, env);
          ok++;
          console.log(`[${++done}/${targets.length}] OK   ${t.basename.slice(0, 48)}`);
        } catch (e: any) {
          failed++;
          console.log(`[${++done}/${targets.length}] NG   ${t.basename.slice(0, 48).padEnd(48)} ${String(e?.message).slice(0, 60)}`);
        }
        if (done % 200 === 0) {
          const per = (Date.now() - t0) / done;
          console.log(`  --- ${done}/${targets.length} 完了  平均 ${(per / 1000).toFixed(2)}秒/曲  残り約 ${fmt(per * (targets.length - done))}`);
        }
      }
    };
    await Promise.all(Array.from({ length: args.workers }, worker));
    const el = Date.now() - t0;
    console.log(`\n完了: ${ok} 成功 / ${failed} 失敗  所要 ${fmt(el)}  平均 ${(el / Math.max(1, done) / 1000).toFixed(2)} 秒/曲`);
    console.log('起伏:', store.envelopeSummary(), `(期待: rms/low とも ${ENV_POINTS * 4})`);
    console.log('※ 既存の特徴量と analyzer_version は変えていません。');
    store.close();
    return;
  }

  store.startRun(`limit=${args.limit ?? 'all'} workers=${args.workers}`);

  if (!args.force) {
    const done = store.doneKeys();
    const before = tracks.length;
    tracks = tracks.filter((t) => !done.has(trackKey(t.size, t.basename)));
    if (before !== tracks.length) console.log(`再開: ${before - tracks.length} 曲は解析済みのためスキップ`);
  }
  if (args.limit) tracks = tracks.slice(0, args.limit);

  if (tracks.length === 0) { console.log('解析対象がありません。'); store.close(); return; }
  console.log(`対象 ${tracks.length} 曲 / ワーカー ${args.workers} 個\n`);

  const queue = [...tracks];
  const total = queue.length;
  let done = 0, ok = 0, failed = 0;
  const t0 = Date.now();

  await new Promise<void>((resolveAll, rejectAll) => {
    let alive = 0;

    const spawnWorker = (): void => {
      const w: ChildProcess = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      alive++;

      const next = (): void => {
        const track = queue.shift();
        if (!track) { w.send({ type: 'bye' }); return; }
        w.send({ type: 'job', track });
      };

      w.on('message', (msg: any) => {
        if (msg.type === 'ready') { next(); return; }
        if (msg.type === 'fatal') { console.error('worker fatal:', msg.error); return; }
        if (msg.type !== 'result') return;

        const r = msg.result;
        done++;
        try {
          if (r.ok) {
            const f = r.features;
            const feat: Features = {
              ...f,
              onsetCurve: Float32Array.from(f.onsetCurve), bandCurves: Float32Array.from(f.bandCurves), onsetGrid: Float32Array.from(f.onsetGrid),
              beatTicks: Float32Array.from(f.beatTicks), mfccMean: Float32Array.from(f.mfccMean),
              mfccVar: Float32Array.from(f.mfccVar), embedding: Float32Array.from(f.embedding),
              taggram: Float32Array.from(f.taggram), windowActivity: Float32Array.from(f.windowActivity),
            };
            store.saveOk(r.track as XmlTrack, feat);
            ok++;
            console.log(`[${done}/${total}] OK   ${r.track.basename.slice(0, 48).padEnd(48)} ` +
              `bpm=${feat.bpmMeasured.toFixed(1)} key=${feat.key}${feat.scale === 'minor' ? 'm' : ''} ` +
              `dance=${feat.danceabilityLogit.toFixed(1)} val=${feat.valence.toFixed(1)} aro=${feat.arousal.toFixed(1)} ${r.ms}ms`);
          } else {
            store.saveFail(r.track as XmlTrack, r.status, r.error);
            failed++;
            console.log(`[${done}/${total}] ${r.status.toUpperCase().padEnd(4)} ${r.track.basename.slice(0, 48).padEnd(48)} ${r.error.slice(0, 60)}`);
          }
        } catch (e: any) {
          failed++;
          console.error(`[${done}/${total}] DB 書き込み失敗 ${r.track?.basename}: ${e?.message}`);
        }

        if (done % 25 === 0 && done < total) {
          const per = (Date.now() - t0) / done;
          console.log(`  --- ${done}/${total} 完了  平均 ${(per / 1000).toFixed(1)}秒/曲  残り約 ${fmt(per * (total - done))}`);
        }
        next();
      });

      w.on('exit', (code) => {
        alive--;
        if (code !== 0 && code !== null && queue.length > 0) {
          console.error(`worker が異常終了しました (code ${code})。補充します。`);
          spawnWorker();
          return;
        }
        if (alive === 0) resolveAll();
      });
      w.on('error', rejectAll);

      w.send({ type: 'init', modelsDir: MODELS_DIR });
    };

    for (let i = 0; i < Math.min(args.workers, queue.length); i++) spawnWorker();
  });

  const elapsed = Date.now() - t0;
  console.log(`\n完了: ${ok} 成功 / ${failed} 失敗  所要 ${fmt(elapsed)}  平均 ${(elapsed / Math.max(1, done) / 1000).toFixed(1)} 秒/曲`);
  console.log('内訳:', store.summary());
  console.log('blob 長:', store.blobLengths(), '(期待: emb 800 / grid 256 / curve 4096 / tag 200 / band 8192)');
  store.close();
  console.log(`\n書き込み先: ${resolve(args.db)}`);
}

main().catch((e) => { console.error('\n中断:', e?.message ?? e); process.exit(1); });
