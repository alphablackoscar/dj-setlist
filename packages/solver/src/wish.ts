// 使いたい曲（wish）。**組んだセトリの 1 曲と入れ替えて混ぜる。** 2026-10-20 ユーザー要求:
//   「使ってほしい曲を 2、3 曲選んで、セトリの中に交えてほしい。
//    テンションとジャンルによっては使えないので、無理に組み込まなくてよい」
//
// 方式 = 後から差し替え（beam に重みを足す方式は採らなかった）:
//   1. ふだん通り組む
//   2. 各位置に「その曲を置いて、他の曲は全部固定」で解き直す（= 既存の --swap と同じ経路。
//      BPM・キー・アーティスト・塊の札・時間帯の制約が全部そのまま効く）
//   3. cost の増え方が一番小さい位置に入れる。増え方が上限を超えたら入れない
// 入れなかった曲は理由を返す。**黙って落とさない。**

import type { SolverTrack, SetlistCandidate } from './types.ts';

export interface WishResult {
  basename: string;
  title: string;
  artist: string;
  /** 入れた位置（1 始まり）。入れなかったら null */
  position: number | null;
  /** 入れ替えで外れた曲 */
  replaced: { title: string; artist: string } | null;
  /** 入れたことで増えた cost */
  costDelta: number | null;
  /** 入れなかった理由。入れたら null */
  reason: string | null;
}

export interface WishOptions {
  /** 入れ替えてはいけない位置（締めの曲・先に入れた wish） */
  locked: Set<number>;
  /** cost の増え方の上限。超えたら「流れが崩れる」として入れない */
  maxDelta: number;
  /**
   * 解き直す前の安い足切り。使えない理由か null を返す。
   * stage = どこまで進んで落ちたか（大きいほど惜しい）。**一番惜しい理由を人に見せる**
   * （例: ヒップホップの曲は大半の位置で「札が違う」で落ちるが、言うべきは
   *  ヒップホップの塊で落ちた理由 = BPM の方）
   */
  prefilter: (t: SolverTrack, position: number) => { stage: number; reason: string } | null;
  /** その位置ごとに固定して解き直す。組めなければ null */
  solveFixed: (fixed: Map<number, string>) => SetlistCandidate | null;
}

const fixedOf = (c: SetlistCandidate) => new Map(c.entries.map((e) => [e.position, e.track.basename]));

/** 1 案に wish を順に入れる。入れた案（入れなければ元の案）と、曲ごとの結果を返す */
export function placeWishes(cand: SetlistCandidate, wishes: SolverTrack[], opts: WishOptions):
  { cand: SetlistCandidate; results: WishResult[] } {
  const results: WishResult[] = [];
  const locked = new Set(opts.locked);
  let cur = cand;
  // **基準の cost も同じ経路（全部固定で解き直す）で出す。** 別案は前の案の曲を避ける下駄を
  // 履いて組まれているので、totalCost をそのまま比べると差が下駄の分だけずれる
  let base = opts.solveFixed(fixedOf(cur))?.totalCost ?? cur.totalCost;

  for (const w of wishes) {
    const r: WishResult = { basename: w.basename, title: w.title, artist: w.artist, position: null, replaced: null, costDelta: null, reason: null };
    results.push(r);
    const already = cur.entries.find((e) => e.track.key === w.key);
    if (already) { r.position = already.position; r.costDelta = 0; locked.add(already.position); continue; }

    // 理由 -> [stage, 回数]
    const why = new Map<string, [number, number]>();
    const note = (stage: number, reason: string) => { const v = why.get(reason) ?? [stage, 0]; v[1]++; why.set(reason, v); };
    let best: { pos: number; cand: SetlistCandidate; delta: number } | null = null;
    for (const e of cur.entries) {
      if (locked.has(e.position)) continue;
      const pre = opts.prefilter(w, e.position);
      if (pre) { note(pre.stage, pre.reason); continue; }
      const fixed = fixedOf(cur);
      fixed.set(e.position, w.basename);
      const got = opts.solveFixed(fixed);
      const placed = got?.entries.find((x) => x.position === e.position)?.track.key === w.key
        && got!.entries.length === cur.entries.length;
      if (!placed) { note(9, '前後の曲と繋がらない（BPM・アーティストの重なり・時間帯）'); continue; }
      const delta = got!.totalCost - base;
      if (!best || delta < best.delta) best = { pos: e.position, cand: got!, delta };
    }

    if (!best) {
      // 一番惜しかった理由を言う。同じ段なら多い方
      r.reason = [...why.entries()].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1])[0]?.[0] ?? '入れられる位置がない';
      continue;
    }
    if (best.delta > opts.maxDelta) {
      r.reason = `入れると流れが崩れる（いちばん合う ${best.pos} 曲目でも cost +${best.delta.toFixed(2)}、上限 +${opts.maxDelta}）`;
      r.costDelta = best.delta;
      continue;
    }
    const out = cur.entries.find((e) => e.position === best!.pos)!;
    r.position = best.pos;
    r.replaced = { title: out.track.title, artist: out.track.artist };
    r.costDelta = best.delta;
    cur = best.cand;
    base = best.cand.totalCost;
    locked.add(best.pos);
  }
  return { cand: cur, results };
}
