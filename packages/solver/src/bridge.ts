// ✂（BPM の跳び）の所に「つなぎ用の曲」を挿し込む。2026-10-17 追加。
//
// なぜ要るか（ユーザー、耳で聴いた判定 2026-10-17）:
//   「100 から 130 のような変化がある時には、自動でトランジションが入るようになればより好ましい」。
// つなぎ用の曲（`... 100-128 Transition`）は曲の途中で BPM が from → to に変わる DJ ツールで、
// まさにこの跳びを繋ぐために作られている。ライブラリに 28 曲あり、27 曲は題名から from→to が読める。
//
// 置き方の約束:
//   - **曲数（position）には入れない。** `Bridge.afterPosition` と次の曲のあいだに置く別の層。
//     position は差し替え・曲を足す・保存と呼び出し・自己検査の鍵なので、番号をずらさない。
//   - つなぎは 1 つのファイルなので**前後に同じピッチがかかる**。片側だけ合わせることはできない。
//     だから from/to の両方が mix_max 以内に収まる曲だけを採る。
//   - 同じつなぎを 1 つのセットで 2 回使わない。

import type { Bridge, SetEntry, SetlistCandidate, SolverTrack } from './types.ts';

export interface BridgeOptions {
  /** 繋いだと見なす BPM 差の上限（cards.json の plan.mix_max）。**両端ともこれ以内に収まること** */
  mixMax: number;
  /** つなぎ自体にかけてよいピッチ量（weights.json の set_bpm.pitch_tolerance） */
  pitchMax: number;
  /** ✂ の位置。その曲番から新しい塊が始まる（= 直前の曲とのあいだがカット）。layout.boundaries と同じ */
  cutAt: Set<number>;
}

/** 相対差。BPM の「何 % 離れているか」 */
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.min(a, b);

/**
 * ✂ ごとに一番よく合うつなぎを選ぶ。合うものが無い ✂ はそのまま（カットで切る）。
 * 返り値は `afterPosition` の昇順。
 */
export function planBridges(
  c: SetlistCandidate,
  transitions: SolverTrack[],
  o: BridgeOptions,
): Bridge[] {
  if (!o.cutAt.size || !transitions.length) return [];
  const byPos = new Map<number, SetEntry>(c.entries.map((e) => [e.position, e]));
  // 題名から from→to が読めた曲だけが候補。読めない曲はどこへ繋ぐか分からないので使わない
  const usable = transitions.filter((t) => t.transition?.from != null && t.transition?.to != null);
  if (!usable.length) return [];

  const used = new Set<string>();
  const out: Bridge[] = [];
  for (const pos of [...o.cutAt].sort((a, b) => a - b)) {
    const prev = byPos.get(pos - 1), next = byPos.get(pos);
    if (!prev || !next) continue;              // セットの先頭の ✂ は繋ぐ相手がいない
    const a = prev.effectiveBpm, b = next.effectiveBpm;

    let best: Bridge | null = null;
    let bestScore = Infinity;
    for (const t of usable) {
      if (used.has(t.key)) continue;
      const from = t.transition!.from!, to = t.transition!.to!;
      // つなぎは 1 曲 = ピッチは 1 つ。前後の要求の真ん中を採る
      const r = ((a / from) + (b / to)) / 2;
      if (Math.abs(r - 1) > o.pitchMax) continue;
      const effFrom = from * r, effTo = to * r;
      if (rel(effFrom, a) > o.mixMax || rel(effTo, b) > o.mixMax) continue;
      // 両端のずれが小さいものを優先し、ピッチは軽い減点。同点は basename で決める（毎回同じ結果にする）
      const score = rel(effFrom, a) + rel(effTo, b) + Math.abs(r - 1) * 0.5;
      if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && best && t.basename < best.track.basename)) {
        bestScore = score;
        best = { afterPosition: pos - 1, track: t, from, to, pitch: r - 1, effFrom, effTo };
      }
    }
    if (best) { used.add(best.track.key); out.push(best); }
  }
  return out;
}

/** 画面と報告に出す 1 行。「つなぎ 100→128（+1.2%）」 */
export function bridgeLabel(b: Bridge): string {
  const p = Math.abs(b.pitch) < 0.0005 ? '' : `（${b.pitch > 0 ? '+' : ''}${(b.pitch * 100).toFixed(1)}%）`;
  return `つなぎ ${b.from}→${b.to}${p}`;
}
