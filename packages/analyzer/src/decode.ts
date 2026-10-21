// ffmpeg で生 PCM(f32le mono) を stdout から受け取る。中間ファイルを作らない。
// 引数は docs/FEATURE_SPEC.md §2 の通り。ここを変えると再現性が壊れる。

import { spawn } from 'node:child_process';
import { EXCERPT_SEC, SCAN_MAX_SEC, SCAN_SPAN_FRAC, SCAN_START_FRAC, WINDOW_POS, WINDOW_SEC } from './types.ts';

function run(cmd: string, args: string[], collectStdout: boolean): Promise<{ out: Buffer; err: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', collectStdout ? 'pipe' : 'ignore', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    if (collectStdout) p.stdout!.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ out: Buffer.concat(chunks), err, code: code ?? -1 }));
  });
}

export async function checkTools(): Promise<void> {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try {
      const r = await run(tool, ['-version'], false);
      if (r.code !== 0) throw new Error(`exit ${r.code}`);
    } catch {
      throw new Error(
        `${tool} が見つかりません。PATH を確認してください。\n` +
        `Windows: winget install Gyan.FFmpeg を実行し、コマンドプロンプトを開き直してください。`);
    }
  }
}

export async function probeDuration(file: string): Promise<number> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], true);
  const d = parseFloat(r.out.toString().trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`長さを取得できません: ${r.err.trim().slice(0, 200)}`);
  return d;
}

/** 指定位置から指定秒数を mono float32 で返す */
export async function decodeAt(file: string, sampleRate: number, start: number, seconds: number): Promise<Float32Array> {
  const r = await run('ffmpeg', [
    '-v', 'error', '-ss', start.toFixed(3), '-t', String(seconds),
    '-i', file, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-',
  ], true);
  if (r.code !== 0) throw new Error(`ffmpeg デコード失敗: ${r.err.trim().slice(0, 200)}`);
  const n = Math.floor(r.out.byteLength / 4);
  if (n < sampleRate / 2) throw new Error(`デコード結果が短すぎます (${n} samples)`);
  // Buffer の byteOffset が 4 の倍数とは限らないため確実にコピーする
  const copy = new ArrayBuffer(n * 4);
  new Uint8Array(copy).set(new Uint8Array(r.out.buffer, r.out.byteOffset, n * 4));
  return new Float32Array(copy);
}

/** 中央 EXCERPT_SEC 秒（v0.2.0 までの方式。短い曲の fallback に使う） */
export async function decodeExcerpt(file: string, sampleRate: number, duration: number): Promise<Float32Array> {
  return decodeAt(file, sampleRate, Math.max(0, (duration - EXCERPT_SEC) / 2), EXCERPT_SEC);
}

/**
 * v0.3.0: 25% / 50% / 75% の位置から WINDOW_SEC 秒ずつ取る。
 * 中央 1 箇所だけだと EDM/トランスのブレイクダウン（キックが抜ける区間）を掴む事故が起きるため。
 * 総秒数は EXCERPT_SEC と同じなので解析時間は増えない。
 */
export async function decodeWindows(file: string, sampleRate: number, duration: number): Promise<Float32Array[]> {
  if (duration < WINDOW_SEC * WINDOW_POS.length) {
    return [await decodeExcerpt(file, sampleRate, duration)];   // 短い曲は従来どおり
  }
  const out: Float32Array[] = [];
  for (const p of WINDOW_POS) {
    const start = Math.max(0, Math.min(duration - WINDOW_SEC, duration * p - WINDOW_SEC / 2));
    out.push(await decodeAt(file, sampleRate, start, WINDOW_SEC));
  }
  return out;
}


/**
 * v0.5.0: 曲の 15% あたりから最大 SCAN_MAX_SEC 秒を **1 回のデコードで**取る。
 * この中から 60 秒の置き場所を選ぶ（features.ts の pickWindow）。
 *
 * v0.3.0 は 3 窓 x 2 サンプルレート = ffmpeg 6 回で 13.7 秒/曲かかっていた。
 * 起動と seek が支配的だったので、1 回にまとめる方が長く取っても速い。
 *
 * @returns signal と、その先頭が曲頭から何秒目か
 */
export async function decodeScan(
  file: string, sampleRate: number, duration: number,
): Promise<{ signal: Float32Array; scanStart: number }> {
  if (duration <= EXCERPT_SEC + 5) {
    // 短い曲は走査する余地が無い。従来どおり中央（実質ほぼ全体）を取る
    return { signal: await decodeExcerpt(file, sampleRate, duration), scanStart: Math.max(0, (duration - EXCERPT_SEC) / 2) };
  }
  const start = Math.max(0, duration * SCAN_START_FRAC);
  const span = Math.min(SCAN_MAX_SEC, duration * SCAN_SPAN_FRAC, duration - start);
  return { signal: await decodeAt(file, sampleRate, start, span), scanStart: start };
}
