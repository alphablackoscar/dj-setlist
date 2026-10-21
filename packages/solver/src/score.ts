// 制約とスコア。cost は小さいほど良い。重みは config/weights.json、流れは config/curves.json。
//
// HARD（破ったら候補ごと捨てる）
//   - 実効 BPM の遷移が ±tolerance 以内
//   - 実効 BPM が bpm_band の中
//   - anime タグの曲は position >= 5
// SOFT（cost として積む）
//   - Camelot 距離 / 音色距離 / 縦ノリ目標との差 / エネルギー目標との差 / 段差 / BPM 幅
//   - **音の群れ**の一貫性 … 隣接ではなくセット全体で見る（groupCost）
//
// **「並べる」判断はジャンルのテキストを見ない。音の群れ（config/sound_groups.json）で見る。**
// テキストのジャンルは「人が選ぶとき」だけに使う（pool.ts の絞り込み）。役割を分けてある。
//
// Camelot 違反は捨てない。MANUAL_CHECK を立てて人間の確認に回す（plan.md S5）。

import type { SolverTrack } from './types.ts';
import { parseCamelot, camelotDistance } from './camelot.ts';
import { timbreDistance } from './pool.ts';

export interface Targets { groove: number[]; energy: number[]; }

/**
 * 位置ごとの目標値を作る。1 曲ずつ単調に上げず、plateau 曲ぶん同じ高さを保ってから段を上げる。
 * 理由: 13 曲で +1-2 BPM ずつのような変化は耳で分からず、上げ幅だけ使い切って後半が詰まるため
 * （plan.md「BPM as energy proxy」の Rejected 項）。
 */
export function buildTargets(curve: any, n: number): Targets {
  const plateau = Math.max(1, Number(curve.plateau ?? 4));
  const steps = Math.max(1, Math.ceil(n / plateau));
  const line = (from: number, to: number): number[] =>
    Array.from({ length: n }, (_, p) => {
      const s = Math.floor(p / plateau);
      return steps > 1 ? from + (to - from) * (s / (steps - 1)) : (from + to) / 2;
    });

  const groove = line(curve.groove.from, curve.groove.to);
  const energy = line(curve.energy.from, curve.energy.to);

  if (curve.dip) {   // 山を 2 つ作るプリセット用。指定位置をなだらかに凹ませる
    const at = Number(curve.dip.at), depth = Number(curve.dip.depth);
    for (let p = 0; p < n; p++) {
      const x = n > 1 ? p / (n - 1) : 0;
      const d = depth * Math.exp(-Math.pow((x - at) / 0.12, 2));
      energy[p] = Math.max(0, energy[p] - d);
    }
  }
  return { groove, energy };
}

export interface ScoreConfig {
  weights: any;
  targets: Targets;
  n: number;
  endBpm: number | null;
  /** おまかせ用。曲ごとの小さな下駄（0-1）。無指定なら効かない */
  jitter?: Map<string, number> | null;
}

/**
 * **セットを回す BPM の計画。** set_bpm から作る。
 *
 * 一定なら全位置で同じ値、区間指定なら位置ごとに切り替わる。
 * null を返すモード（従来方式）では「隣どうしが近ければよい」に戻る。
 */
export type BpmPlan = ((setPos: number) => number) | null;

export function buildBpmPlan(setBpm: number | { from: number; bpm: number }[] | null | undefined): BpmPlan {
  if (setBpm == null) return null;
  if (typeof setBpm === 'number') return () => setBpm;
  const phases = [...setBpm].sort((a, b) => a.from - b.from);
  if (!phases.length) return null;
  return (setPos: number) => {
    let v = phases[0].bpm;
    for (const p of phases) if (setPos >= p.from) v = p.bpm;
    return v;
  };
}

/**
 * 原曲からのピッチ量に付く cost。**快適域(pitch_comfort)を超えた分だけ積む。**
 *
 * 業界の目安（2026-08-08 に調査）: 機材の標準は ±8%、多くの DJ は ±6% 以内。
 * キーロックを使うと音質が落ちるので、寄せる量は少ないほどよい。
 * よって「上限までは使ってよいが、寄せるほど不利」という形にしてある。
 */
export function pitchCost(pitch: number, cfg: ScoreConfig): number {
  const comfort = Number(cfg.weights.set_bpm?.pitch_comfort ?? 0.03);
  const limit = Number(cfg.weights.set_bpm?.pitch_tolerance ?? 0.05);
  const over = Math.abs(pitch) - comfort;
  if (over <= 0) return 0;
  return (cfg.weights.soft.pitch ?? 0) * Math.min(1, over / Math.max(1e-6, limit - comfort));
}

/** 目標との差だけで決まる、その曲単体の cost（1 曲目のシードにも使う） */
export function fitCost(t: SolverTrack, setPos: number, eff: number, mult: number, cfg: ScoreConfig, pitch = 0): number {
  const w = cfg.weights.soft;
  const i = setPos - 1;
  let cost = w.groove_target * Math.abs(t.groove - cfg.targets.groove[i])
           + w.energy_target * Math.abs(t.energy - cfg.targets.energy[i])
           + pitchCost(pitch, cfg);
  // おまかせ。曲ごとの小さな下駄で最良解をずらす。HARD 制約は一切ゆるめない
  if (cfg.jitter) cost += (w.random ?? 0) * (cfg.jitter.get(t.key) ?? 0);
  // ハーフタイム / ダブルタイムで掛けるのは意図的な判断。ただ乗りできないよう cost を付ける
  if (mult !== 1) cost += w.multiplier ?? 0;
  if (cfg.endBpm && setPos === cfg.n) {
    // 終曲の BPM 目安。外れるほど積む（HARD ではない）
    cost += w.bpm_step * Math.min(1, Math.abs(eff - cfg.endBpm) / (cfg.endBpm * 0.1));
  }
  return cost;
}

/** BPM の HARD 判定。分母を小さい方に揃えて向きに依存しないようにする */
export function bpmCompatible(effA: number, effB: number, tolerance: number): boolean {
  return Math.abs(effA - effB) / Math.min(effA, effB) <= tolerance;
}

export interface PairScore { cost: number; flags: string[]; }

/**
 * セット順で隣り合う 2 曲の cost。prev -> next の向きで呼ぶこと。
 * cut = カットで入る境目（長いセットの段の切り替え）。BPM の差は切り替えで吸収する前提なので bpm_step を積まず、
 * ±tolerance を超えていれば CUT を立てて人に見せる。
 */
export function pairCost(prev: SolverTrack, next: SolverTrack, prevEff: number, nextEff: number, cfg: ScoreConfig, cut = false): PairScore {
  const w = cfg.weights.soft;
  const cc = cfg.weights.camelot_cost;
  const flags: string[] = [];
  let cost = 0;

  const d = camelotDistance(parseCamelot(prev.camelot), parseCamelot(next.camelot));
  if (d == null) cost += w.camelot * Number(cc.unknown);
  else {
    cost += w.camelot * Number(cc[String(d)]);
    if (d >= 3) flags.push('MANUAL_CHECK');
  }

  cost += w.timbre * Math.min(1, timbreDistance(prev.timbre, next.timbre) / 2);

  const maxStep = Number(cfg.weights.energy_step.max_step);
  const over = Math.abs(next.energy - prev.energy) - maxStep;
  if (over > 0) cost += w.energy_step * Math.min(1, over / Math.max(1e-6, 1 - maxStep));

  const tol = Number(cfg.weights.hard.bpm_tolerance);
  const bpmGap = Math.abs(nextEff - prevEff) / Math.min(nextEff, prevEff);
  if (cut) { if (bpmGap > tol) flags.push('CUT'); }
  else cost += w.bpm_step * bpmGap / tol;

  return { cost, flags };
}

/**
 * 目標との差だけを見る安いスコア。beam の候補を絞る前段に使う（音色計算を全曲に走らせないため）。
 *
 * **おまかせの乱数はここにも効かせる。** ここに入れないと、毎回まったく同じ上位 60 曲しか
 * 検討されず、最終 cost に下駄を履かせても結果があまり変わらない（実測: 3 回まわして
 * 77% / 38% しか入れ替わらなかった）。候補の入り口を揺らすのが要点。
 */
export function cheapCost(t: SolverTrack, setPos: number, cfg: ScoreConfig): number {
  const i = setPos - 1;
  const base = Math.abs(t.groove - cfg.targets.groove[i]) + Math.abs(t.energy - cfg.targets.energy[i]);
  return cfg.jitter ? base + (cfg.weights.soft.random ?? 0) * (cfg.jitter.get(t.key) ?? 0) : base;
}

/**
 * 文脈タグごとの位置制約。`config/contexts.json` の position_min（タグ -> 最小位置）で決まる。
 * 「使ってよいが頭からは出さない」もの用。完全に外すものは pool 構築時に落としている。
 */
export function positionAllowed(t: SolverTrack, setPos: number, positionMin: Record<string, number>): boolean {
  for (const tag of t.contextTags) {
    const min = positionMin[tag];
    if (min != null && setPos < Number(min)) return false;
  }
  return true;
}


/**
 * セット全体の性格の一貫性。**隣り合う 2 曲ではなくセット全体で見る。**
 *
 * 判断の単位は **音の群れ（config/sound_groups.json の g1..g8）**であって、
 * ジャンルのテキストではない。ユーザー指示 2026-08-08:
 *   「その曲が四つ打ちか pops なのかはどうでもいい。大事なのは厳密な定義ではなく
 *     セトリを作った時におかしいかどうか」
 *
 * ジャンルのテキストを使っていた頃の穴（実測で発覚し、つじつま合わせで塞いでいた）:
 *   ライブラリの 34% はジャンル欄が空。空欄を 1 曲挟むだけでジャンル変更がタダになるので、
 *   「ヒップホップ → ラテン → ハウス → ハードコア → ポップ」が最良解になっていた。
 *   かといって空欄をタダにしないと今度は「不明な曲だけ 13 曲」が最安になる。
 *   両側を塞ぐために `family_unknown` という調整値が必要だった。
 *
 * **音の群れには「不明」が存在しない**（全曲が必ずどれかに入る）ので、この問題ごと消えた。
 * `family_unknown` は不要になり、削除した。
 *
 * @param lastGroup  直前の曲の群
 * @param seenGroups そのセットで既に使った群
 */
export function groupCost(
  t: SolverTrack, lastGroup: string | null, seenGroups: Set<string>, cfg: ScoreConfig,
): number {
  const w = cfg.weights.soft;
  if (!t.soundGroup) return 0;   // sound_groups.json が無いときは何もしない
  let cost = 0;
  if (lastGroup && t.soundGroup !== lastGroup) cost += w.group ?? 0;
  // セットにまだ無い群を持ち込むこと自体に cost を付ける。これがセット全体の性格を保つ力になる
  if (!seenGroups.has(t.soundGroup)) cost += w.group_new ?? 0;
  return cost;
}


/**
 * 塊（ブロック）の構造。
 *
 * DJ のセットは「レゲエ 2 曲 → ラテン 3 曲」のように**小さい塊の連なり**であって、
 * 1 曲ずつ変わることも、13 曲すべて同じことも無い。
 *
 * **塊の単位は音の区画（cells / 24 個）。** 粗い群(8)では EDM の箱で塊が 1〜2 個に
 * なってしまい、切れ目が見えない（もともと family(9) が粗すぎて canonical(39) を
 * 使っていたのと同じ理由）。
 *
 * ジャンルのテキストを使っていた頃にあった「canonical が無い曲は塊を切りも伸ばしもしない
 * 透明な存在」という特例は、**区画に空きが無くなったので不要になり、削除した。**
 *
 * @returns cost と、この曲を足したあとの塊の状態
 */
export function blockCost(
  t: SolverTrack, lastCell: string | null, runLength: number, cfg: ScoreConfig,
): { cost: number; cell: string | null; run: number } {
  const w = cfg.weights.soft;
  const min = Number(cfg.weights.block?.min ?? 3);
  const max = Number(cfg.weights.block?.max ?? 3);
  const cell = t.soundCell || null;
  if (!cell) return { cost: 0, cell: lastCell, run: runLength };   // 区画が無い＝設定ファイルが無いとき
  if (!lastCell) return { cost: 0, cell, run: 1 };

  if (cell === lastCell) {
    const run = runLength + 1;
    // 塊が長すぎる。超えたぶんだけ 1 曲ごとに積む
    return { cost: run > max ? (w.block_too_long ?? 0) * (run - max) : 0, cell, run };
  }
  // 変わる。塊が短すぎるなら cost（1 曲ずつコロコロ変わるのを防ぐ）
  return { cost: runLength < min ? (w.block_too_short ?? 0) * (min - runLength) : 0, cell, run: 1 };
}

/**
 * 箱の色から外れているぶんの cost。**HARD ではない。**
 * 「BPM が同じくらいならレゲエが混ざっても問題は言われない」という実務に合わせている。
 * 厳密に絞りたいときは --groups / --genres（そちらは HARD）を使う。
 *
 * 色の指定は **音の群れ（g1..g8）**。ジャンルのテキストではない
 * （config/venues.json の tone）。
 */
export function venueToneCost(t: SolverTrack, tone: string[] | null, cfg: ScoreConfig): number {
  if (!tone?.length || !t.soundGroup) return 0;
  return tone.includes(t.soundGroup) ? 0 : (cfg.weights.soft.venue_tone ?? 0);
}

