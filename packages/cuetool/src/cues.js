// 1 曲ぶんの**メモリーＱの位置**を決める。音源を読むのはここだけ。
//
// 出すのは **5 点**（ユーザーが実機で直した正解に合わせた。docs/DECISIONS.md 2026-10-19）:
//
//   曲頭 / イントロ終わり / メイン開始 / メイン終わり / アウトロ開始
//
// **8 小節ごとの梯子は出さない。** 2026-10-17 の案（イントロ終わりまで 8 小節ごとに置く）は
// 2026-10-19 の実機で**ユーザーが 9 / 25 / 33 / 89 小節のＱを消した**ことで否定された
// （「8 小節ごとに全部置くのは多すぎる」）。唯一の名前つき正解である
// `Don't Lose Your Head` もちょうどこの 5 点で、5 本とも 8 小節線にずれ 0 ms。
//
// **当たる率は高くない**（174 曲で イントロ終わり 59% / メイン開始 53% /
// メイン終わり 49% / アウトロ開始 33%。`node scripts/cue/eval.js` で測る）。
// アウトロは**目で直す前提**。直す場所は rekordbox 側（取り込みが既存Ｑにマージされる）。

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decode, beatTimes, barFeatures, trueTempos, SR } from './features.js';
import { detectCues } from './detect.js';
import { tempoOf, locationPath, hasCues, basenameOf } from './collection.js';

/**
 * Ｑの並び順と名前。**この順序が「前より後ろ」の検査の基準になる**。
 *
 * **2026-10-21 に作り直した**（ユーザー指摘:「Ｑの打ち方を誤解している」）:
 *   - **メイン = DJ 用語で曲が一番盛り上がる部分**（エネルギーが強く、歌が薄い）。
 *     それまで「メイン」と呼んでいた所は**曲の始まり（イントロの終わり）**だった。
 *   - 盛り上がりが **8 小節何個分か**をＱで示す（`mainSteps` が中の 8 小節線）。
 *
 * 本人の流儀の実測（189 曲 1512 個。`node scripts/cue/style.js`）:
 *   1 曲 **8 個**（中央値）/ 隣の間隔の **50.2% がちょうど 8 小節** /
 *   8 小節の連が 1 曲 **2.02 本**（長さ 2 本 51% / 3 本 33% / 4 本 11%）。
 *   → **5 点では足りていなかった。**
 */
export const CUE_ORDER = [
  { key: 'head', label: '頭' },
  { key: 'intro', label: 'イントロ終' },
  { key: 'songStart', label: '始まり' },
  { key: 'main', label: 'メイン' },
  { key: 'mainEnd', label: 'メイン終' },
  { key: 'outro', label: 'アウトロ' },
];

/**
 * 1 曲のＱを決める。**音源が無い / Ｑが既にある / 解析できない場合は理由を返す**（例外にしない）。
 *
 * @param block    collection.xml の TRACK 1 曲ぶん（**そのまま写して使う**）
 * @param measuredBpm  features.db の `bpm_measured`。倍/半分のグリッドを直すのに使う
 * @returns {{ ok: boolean, reason?: string, cues?: {key,label,bar,sec}[], bars?: number, dropped?: string[] }}
 */
export function cuesForTrack(block, measuredBpm) {
  if (hasCues(block)) return { ok: false, reason: '既にＱがあるので触っていません' };
  const file = locationPath(block);
  if (!file) return { ok: false, reason: 'XML に音源の場所がありません' };
  if (!existsSync(file)) return { ok: false, reason: '音源が見つかりません' };
  const tempos0 = tempoOf(block);
  if (!tempos0.length) return { ok: false, reason: 'ビートグリッドがありません' };

  let bars, det;
  try {
    const pcm = decode(file);
    // **グリッドを実速に直す**（rekordbox が倍/半分に記録している曲が約 800 ある）
    const tempos = trueTempos(tempos0, measuredBpm);
    bars = barFeatures(pcm, beatTimes(tempos, pcm.length / SR));
    det = detectCues(bars);
  } catch (e) {
    return { ok: false, reason: `解析できません: ${String(e.message ?? e).slice(0, 80)}` };
  }
  if (!det || bars.length < 24) return { ok: false, reason: '短すぎて構造が読めません' };

  // 小節番号 → 秒。**bars[i].t は実際のビートグリッドの時刻**なので、ここで計算し直さない
  // （小節の長さを掛け算で出すと、可変グリッドの 692 曲でずれる）
  const at = (bar) => (bar >= 0 && bar < bars.length ? bars[bar].t : null);
  const picked = [];
  const dropped = [];
  for (const { key, label } of CUE_ORDER) {
    const bar = key === 'head' ? 0 : det[key];
    const sec = bar == null ? null : at(bar);
    if (sec == null) { dropped.push(`${label}（小節が範囲外）`); continue; }
    const prev = picked[picked.length - 1];
    // **同じ小節に重なったら名前を合わせて 1 本にする。** 落とさない。
    // 検出器は「イントロ終わり = メイン開始」を返すことがあり（53 曲のセットで 7 曲）、
    // ブレイクを挟まない曲ではそれが正しい。
    // **8 小節あとから探し直す形も試して却下した**（2026-10-20 に 174 曲で実測。
    // メイン開始の一致が 53% → 45% に落ちた。重なる小節はたいてい当たっている）。
    if (prev && bar === prev.bar) { prev.label += `/${label}`; prev.keys.push(key); continue; }
    // **前のＱより前に来たら足さない。** ずらして辻褄を合わせない
    // （当たっていない位置を当たったように見せないため）
    if (prev && bar < prev.bar) { dropped.push(`${label}（${prev.label}より前）`); continue; }
    picked.push({ key, keys: [key], label, bar, sec });
    // **メインの中を 8 小節ごとに刻む。** これが「盛り上がりが 8 小節何個分か」の答え
    // （ユーザー要求 2026-10-21）。名前に何本目かを入れて、数えなくても分かるようにする。
    if (key === 'main') {
      for (const [k, b2] of (det.mainSteps ?? []).entries()) {
        const s2 = at(b2);
        if (s2 == null || b2 <= bar) continue;
        picked.push({ key: 'mainStep', keys: ['mainStep'], label: `メイン${k + 2}`, bar: b2, sec: s2 });
      }
    }
  }
  return { ok: true, cues: picked, bars: bars.length, dropped, mainBars: det.mainBars ?? 0 };
}

/**
 * features.db から basename → bpm_measured を引く表を作る。
 *
 * `node:sqlite` は **システムの Node 24** で動く。Electron 同梱の Node 20 には無いので、
 * この package は**必ず子プロセス（システムの node）から呼ぶ**。
 * packages/app の main.js で直接 import しないこと（2026-10-03 に同じ罠で落ちた）。
 */
export function measuredBpmMap(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const m = new Map();
  for (const r of db.prepare(
    "select basename, bpm_measured from tracks where status='done' and bpm_measured>0").all()) {
    m.set(r.basename, r.bpm_measured);
  }
  db.close();
  return m;
}

export { basenameOf };
