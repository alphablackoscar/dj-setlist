// Long set (1-2 h) built from genre blocks. Enabled by --long.
//
// Two levels (user-approved 2026-10-16):
//   block = 3-4 tracks of one genre card. Genre changes only here. BPM close -> normal mix.
//   stage = BPM zone. Cut only where zone changes (1-2 per hour).
//
//   [HipHop 3][Reggae 3][Latin 4][R&B 3] ✂ [Pops 4][Remix 3][House 3][BigRoom 4]
//
// Flow rules:
//   - each card has level 1-5. Next block rises max 1 level (no lowbeat -> EDM jump).
//   - dropping allowed (breather), but costs.
//   - overall rise follows chosen curve (curves.json).
//
// Solved in 2 steps: (1) planBlocks picks block order (card, size, BPM) -> (2) beam fills positions w/ card tracks.
// (1) picks no tracks -> cheap (ms). (2) = existing beam + per-position card filter.

import type { SolverTrack } from './types.ts';
import { buildTargets, type Targets } from './score.ts';

export interface Card {
  id: string; label: string; level: number;
  genres: string[]; untagged_groups: string[];
  anime?: boolean; tag?: string; default_on?: boolean;
  /** Block BPM limited to this range (optional). Lowbeat cards: keeps them in lowbeat zone. */
  bpm_range?: [number, number];
}
const inRange = (c: Card | undefined, v: number) => !c?.bpm_range || (v >= c.bpm_range[0] && v <= c.bpm_range[1]);

/** Track -> card. Priority: anime flag > genre field > sound group (genre empty). No match -> null (unused in long set). */
export function cardOf(t: SolverTrack, cards: Card[]): string | null {
  if (t.isAnime) return cards.find((c) => c.anime)?.id ?? null;
  if (t.canonical) return cards.find((c) => c.genres.includes(t.canonical))?.id ?? null;
  return cards.find((c) => c.untagged_groups.includes(t.soundGroup))?.id ?? null;
}

/** One block. ResolvedBlock.cut = entering this block is a cut (BPM far from previous block). */
export interface Block {
  card: string;
  n: number;
  bpm: number;
}
export interface ResolvedBlock extends Block {
  index: number; label: string; level: number;
  start: number; end: number;   // 1-based, inclusive
  cut: boolean;
}

export interface PlanCtx {
  cards: Card[];
  /** Cards allowed today */
  palette: string[];
  n: number;
  curve: any;
  /** Track key -> card id */
  cardMap: Map<string, string>;
  pool: SolverTrack[];
  cfg: any;              // cards.json 'plan'
  seed: number | null;
  /** Card id -> first position its block may start (contexts.json position_min) */
  minPos: Record<string, number>;
  /** Closing track. Last block forced to its card + BPM. */
  anchor: SolverTrack | null;
}

/** BPM list per card (ascending). Used for feasibility + BPM candidates. */
function cardBpms(ctx: PlanCtx): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const t of ctx.pool) {
    const c = ctx.cardMap.get(t.key);
    if (c) (m.get(c) ?? m.set(c, []).get(c)!).push(t.bpm);
  }
  for (const v of m.values()) v.sort((a, b) => a - b);
  return m;
}

/** Per card: {bpm, energy} (ascending by bpm). Used to tell whether a card can carry the energy a slot needs. */
function cardTracks(ctx: PlanCtx): Map<string, { bpm: number; energy: number }[]> {
  const m = new Map<string, { bpm: number; energy: number }[]>();
  for (const t of ctx.pool) {
    const c = ctx.cardMap.get(t.key);
    if (c) (m.get(c) ?? m.set(c, []).get(c)!).push({ bpm: t.bpm, energy: t.energy });
  }
  for (const v of m.values()) v.sort((a, b) => a.bpm - b.bpm);
  return m;
}

/**
 * Best mean energy a card could realistically reach for a `size`-track block at `v` BPM:
 * mean of the `size` highest-energy tracks within ±tol. Returns null if it has fewer than `size`.
 *
 * Why this exists (2026-10-17): feasibility used to be "are there enough tracks near this BPM",
 * which ignored energy. The techno card has tracks at 127-131 BPM but almost none above 0.6,
 * so a techno block placed late (energy target ~0.8) always came out 0.10-0.21 below its
 * neighbours - an audible slump right before the finale, in 17 of 45 measured candidates.
 */
function supplyEnergy(ts: { bpm: number; energy: number }[], v: number, tol: number, size: number): number | null {
  const e: number[] = [];
  for (const t of ts) if (Math.abs(v - t.bpm) / t.bpm <= tol) e.push(t.energy);
  if (e.length < size) return null;
  e.sort((a, b) => b - a);
  // Average the top `size * DEPTH`, not the top `size`: the filler also has to satisfy key / timbre /
  // BPM-step, so it rarely gets the single best tracks. Measured at 129 BPM: top-4 puts techno at 0.77
  // (close to house 0.88 - no separation), while this depth puts it at 0.67 vs 0.86, which matches
  // what the filler actually achieves. A card with fewer tracks than that uses all it has - correct,
  // since a thin card has no room to choose either.
  const take = Math.min(e.length, size * 4);
  let sum = 0;
  for (let i = 0; i < take; i++) sum += e[i];
  return sum / take;
}

/** Number of tracks pitchable to BPM v within ±tol */
function countNear(bpms: number[], v: number, tol: number): number {
  let n = 0;
  for (const b of bpms) if (Math.abs(v - b) / b <= tol) n++;
  return n;
}

/** Card's typical BPMs: up to 3 density peaks (±3% window). */
function peaks(bpms: number[]): number[] {
  const dens: { v: number; d: number }[] = [];
  for (let v = 70; v <= 175; v++) dens.push({ v, d: countNear(bpms, v, 0.03) });
  const out: { v: number; d: number }[] = [];
  for (let i = 0; i < dens.length; i++) {
    const { v, d } = dens[i];
    if (d < 6) continue;
    const l = dens[i - 1]?.d ?? -1, r = dens[i + 1]?.d ?? -1;
    if (d >= l && d > r) out.push({ v, d });
  }
  // Merge peaks within ±4% (keep larger). Drop small peaks (< 1/4 of largest).
  // W/o this, planner collected rare tracks (e.g. house at 108 BPM) and crawled BPM up to avoid cut (observed).
  out.sort((a, b) => b.d - a.d);
  const kept: { v: number; d: number }[] = [];
  for (const p of out) {
    if (p.d < out[0].d / 4) break;
    if (!kept.some((k) => Math.abs(k.v - p.v) / p.v < 0.04)) kept.push(p);
  }
  return kept.slice(0, 3).map((p) => p.v);
}

interface PState {
  blocks: Block[];
  pos: number;          // tracks filled
  cost: number;
  uses: Map<string, number>;   // card -> tracks used
  count: Map<string, number>;  // card -> blocks used
}

/**
 * Decide block order. Picks no tracks.
 * Returns best single plan (3 alternatives = same plan, different tracks; new plan = 'おまかせ' / new seed).
 */
export function planBlocks(ctx: PlanCtx): { blocks: Block[]; notes: string[] } {
  const notes: string[] = [];
  const cfg = ctx.cfg;
  const cards = ctx.cards.filter((c) => ctx.palette.includes(c.id));
  const byCard = cardBpms(ctx);
  const usable = cards.filter((c) => (byCard.get(c.id)?.length ?? 0) >= 3);
  for (const c of cards) if (!usable.includes(c)) notes.push(`「${c.label}」は曲が足りないので使いません`);
  if (!usable.length) return { blocks: [], notes: [...notes, '使える札がありません'] };

  const byCardT = cardTracks(ctx);
  const pk = new Map(usable.map((c) => [c.id, peaks(byCard.get(c.id)!.filter((b) => inRange(c, b)))]));
  const minL = Math.min(...usable.map((c) => c.level));
  const maxL = Math.max(...usable.map((c) => c.level));
  const n = ctx.n;
  // Curve energy target -> 0-1 -> stretched to palette level range.
  // Top level reserved for last peak_reserve fraction: before it, target climbs only to top-1
  // (else 2 h set hits top at ~60% and stays flat for ~45 min; measured 2026-10-16).
  const tg = buildTargets(ctx.curve, n).energy;
  const e0 = ctx.curve.energy.from, e1 = ctx.curve.energy.to;
  const reserve = Number(cfg.peak_reserve ?? 1);
  const reserveAt = Math.floor(n * reserve);
  const preTop = Math.max(minL, maxL - 1);
  const levelAt = (pos: number) => {
    if (pos > reserveAt) return maxL;
    const x = Math.min(1, Math.max(0, (tg[pos - 1] - e0) / ((e1 - e0) || 1)));
    return minL + (preTop - minL) * Math.min(1, x / Math.max(reserve, 1e-6));
  };

  let rnd = (ctx.seed ?? 0) | 0 || 1;
  const jitter = new Map<string, number>();
  const jit = (k: string) => {
    if (ctx.seed == null) return 0;
    let v = jitter.get(k);
    if (v == null) { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; v = rnd / 0x7fffffff; jitter.set(k, v); }
    return v;
  };

  const sizes: number[] = cfg.sizes ?? [3, 4];
  // Can remaining count be filled exactly by 3/4-track blocks (not: 1, 2, 5)
  const reachable = (r: number): boolean => {
    const ok = [true];
    for (let i = 1; i <= r; i++) ok[i] = sizes.some((s) => i >= s && ok[i - s]);
    return !!ok[r];
  };
  const sizeOptions = (rest: number): number[] => {
    const o = sizes.filter((s) => s <= rest && reachable(rest - s));
    return o.length ? o : [rest];   // unfillable (e.g. total 5) -> rest as 1 block
  };
  const tol = Number(cfg.pitch ?? 0.05);
  const mixMax = Number(cfg.mix_max ?? 0.05);
  const anchorCard = ctx.anchor ? ctx.cardMap.get(ctx.anchor.key) ?? null : null;
  if (ctx.anchor && !anchorCard) notes.push(`締めの「${ctx.anchor.title}」はどの札にも入らないので、締めの指定を流れの決定には使いません`);

  let states: PState[] = [{ blocks: [], pos: 0, cost: 0, uses: new Map(), count: new Map() }];
  const done: PState[] = [];
  const width = Number(cfg.beam_width ?? 300);

  for (let step = 0; step < n && states.length; step++) {
    const next: PState[] = [];
    for (const st of states) {
      const rest = n - st.pos;
      const prev = st.blocks[st.blocks.length - 1];
      const prevCard = prev ? usable.find((c) => c.id === prev.card)! : null;
      for (const size of sizeOptions(rest)) {
        const isLast = size === rest;
        for (const c of usable) {
          if (prev && c.id === prev.card) continue;                          // same card twice = 1 block
          if (prevCard && c.level > prevCard.level + 1) continue;            // rise max 1 level
          if ((ctx.minPos[c.id] ?? 1) > st.pos + 1) continue;                // e.g. anime not before track N
          if (isLast && anchorCard && c.id !== anchorCard) continue;
          const bpms = byCard.get(c.id)!;
          // BPM candidates: card peaks / previous block BPM kept or raised slightly.
          // Latter only if within ±4% of a card peak -> never build card at unusual tempo.
          const own = pk.get(c.id)!;
          const opts = new Set<number>(own);
          if (prev) for (const k of [1, 1.02, 1.04]) {
            const v = Math.round(prev.bpm * k * 10) / 10;
            if (own.some((p) => Math.abs(v - p) / p <= 0.04)) opts.add(v);
          }
          if (isLast && anchorCard) { opts.clear(); opts.add(Math.round(ctx.anchor!.bpm)); }
          const need = Math.ceil(((st.uses.get(c.id) ?? 0) + size) * Number(cfg.min_tracks_factor ?? 2));
          for (const bpm of opts) {
            if (!inRange(c, bpm)) continue;
            if (countNear(bpms, bpm, tol) < need) continue;
            let cost = 0;
            const mid = st.pos + (size + 1) / 2;
            cost += cfg.level * Math.abs(c.level - levelAt(Math.round(mid)));
            if (prevCard && c.level < prevCard.level) cost += cfg.down * (prevCard.level - c.level);
            if (c.level === maxL && maxL > minL && st.pos < reserveAt) cost += Number(cfg.peak_early ?? 0);
            if (isLast && c.level < maxL) cost += Number(cfg.end_not_top ?? 0);   // finale = top level
            cost += cfg.repeat * (st.count.get(c.id) ?? 0);
            // **その札がこの位置のエネルギーを出せるか。** 曲数だけ見ていると、
            // 速さは合うが大人しい札（テクノ）が終盤に入り、そこだけ明確に落ちる。
            const supply = supplyEnergy(byCardT.get(c.id) ?? [], bpm, tol, size);
            if (supply == null) continue;
            const wantE = tg[Math.min(n, Math.max(1, Math.round(mid))) - 1];
            cost += Number(cfg.energy_gap ?? 0) * Math.max(0, wantE - supply);
            if (prev) {
              const d = Math.abs(bpm - prev.bpm) / Math.min(bpm, prev.bpm);
              if (d > mixMax) cost += bpm > prev.bpm ? cfg.cut : cfg.cut_down;
              else if (bpm < prev.bpm) cost += cfg.drift_down * d / mixMax;
            }
            cost += (cfg.random ?? 0) * jit(`${st.blocks.length}|${c.id}`);
            const uses = new Map(st.uses); uses.set(c.id, (uses.get(c.id) ?? 0) + size);
            const count = new Map(st.count); count.set(c.id, (count.get(c.id) ?? 0) + 1);
            const ns: PState = { blocks: [...st.blocks, { card: c.id, n: size, bpm }], pos: st.pos + size, cost: st.cost + cost, uses, count };
            (ns.pos === n ? done : next).push(ns);
          }
        }
      }
    }
    next.sort((a, b) => a.cost - b.cost);
    // Merge near-duplicates (same filled count, last card, BPM ±2, card usage). W/o this, BPM variants of one route
    // fill the beam and a route that is dearer mid-way but closes better (techno -> EDM finale) gets pruned (observed).
    const seen = new Set<string>();
    states = [];
    for (const st of next) {
      const last = st.blocks[st.blocks.length - 1];
      const key = `${st.pos}|${last.card}|${Math.round(last.bpm / 2)}|${[...st.count].sort().join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key); states.push(st);
      if (states.length >= width) break;
    }
  }
  if (!done.length) return { blocks: [], notes: [...notes, '塊の並びが作れませんでした（使える札が少なすぎるか、1 段ずつ上げる決まりで届かない）'] };
  done.sort((a, b) => a.cost - b.cost);
  return { blocks: done[0].blocks, notes };
}

/** Block order -> position ranges */
export function resolveBlocks(blocks: Block[], cards: Card[], mixMax: number): ResolvedBlock[] {
  let pos = 1;
  return blocks.map((b, i) => {
    const c = cards.find((x) => x.id === b.card);
    const prev = blocks[i - 1];
    const r: ResolvedBlock = {
      ...b, index: i, label: c?.label ?? b.card, level: c?.level ?? 0,
      start: pos, end: pos + b.n - 1,
      cut: !!prev && Math.abs(b.bpm - prev.bpm) / Math.min(b.bpm, prev.bpm) > mixMax,
    };
    pos += b.n;
    return r;
  });
}

/** Per-position info for beam */
export interface Layout {
  n: number;
  blocks: ResolvedBlock[];
  blockAt: (pos: number) => number;
  /** Track allowed at position (card matches). HARD */
  allowAt: (pos: number, t: SolverTrack) => boolean;
  /** First positions of cut blocks. Only here BPM gap vs neighbor not HARD. */
  boundaries: Set<number>;
  /** Phases, directly usable as set_bpm */
  phases: { from: number; bpm: number }[];
  targets: Targets;
}

/**
 * peak = { energy: [from, to] } -> track energy target inside top-level stretch (from first top-level block to end)
 * climbs from..to; before it, curve energy ends just below 'from'. Keeps set rising to the end.
 */
export function buildLayout(blocks: ResolvedBlock[], curve: any, cardMap: Map<string, string>,
                            peak: { energy: [number, number] } | null = null): Layout {
  const n = blocks.reduce((a, b) => a + b.n, 0);
  const at = new Int32Array(n + 2);
  for (const b of blocks) for (let p = b.start; p <= b.end; p++) at[p] = b.index;
  const blockAt = (p: number) => at[Math.min(Math.max(p, 1), n)];
  const phases: { from: number; bpm: number }[] = [];
  for (const b of blocks) if (!phases.length || phases[phases.length - 1].bpm !== b.bpm) phases.push({ from: b.start, bpm: b.bpm });
  return {
    n, blocks, blockAt,
    allowAt: (p, t) => cardMap.get(t.key) === blocks[blockAt(p)].card,
    boundaries: new Set(blocks.filter((b) => b.cut).map((b) => b.start)),
    phases,
    targets: peakTargets(blocks, curve, n, peak),
  };
}

function peakTargets(blocks: ResolvedBlock[], curve: any, n: number, peak: { energy: [number, number] } | null): Targets {
  const base = buildTargets(curve, n);
  const top = Math.max(...blocks.map((b) => b.level));
  const first = blocks.find((b) => b.level === top);
  if (!peak || !first || first.start <= 1) return base;
  const pre = first.start - 1, rest = n - pre;
  const [pf, pt] = peak.energy;
  const a = buildTargets({ ...curve, dip: undefined, energy: { from: curve.energy.from, to: Math.min(curve.energy.to, pf - 0.05) } }, pre);
  const b = buildTargets({ ...curve, dip: undefined, energy: { from: pf, to: pt } }, rest);
  return { groove: base.groove, energy: [...a.energy, ...b.energy] };
}

/**
 * BPM after changing block's card: keep current if enough tracks, else nearest card peak.
 */
export function bpmForCard(card: string, want: number, size: number, ctx: Pick<PlanCtx, 'pool' | 'cardMap' | 'cfg'>,
                           cardDef?: Card): number | null {
  const bpms = ctx.pool.filter((t) => ctx.cardMap.get(t.key) === card).map((t) => t.bpm)
    .filter((b) => inRange(cardDef, b)).sort((a, b) => a - b);
  if (!inRange(cardDef, want)) want = cardDef!.bpm_range![want < cardDef!.bpm_range![0] ? 0 : 1];
  const tol = Number(ctx.cfg.pitch ?? 0.05);
  const need = size * 2;
  if (countNear(bpms, want, tol) >= need) return want;
  const cands = peaks(bpms).filter((v) => countNear(bpms, v, tol) >= need);
  if (!cands.length) return countNear(bpms, want, tol) >= size ? want : null;
  return cands.sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
}

/**
 * Card removed (e.g. anime unchecked) -> replace only that card's blocks w/ card fitting neighbors.
 * Other blocks untouched. Replacement = close level / differs from neighbors / keeps 1-level rule / enough tracks.
 */
export function substituteCards(
  blocks: Block[], removed: Set<string>, cards: Card[], palette: string[],
  ctx: Pick<PlanCtx, 'pool' | 'cardMap' | 'cfg'>,
  /** Locked blocks. Untouched even if card removed. */
  locked: Set<number> = new Set(),
): { blocks: Block[]; changed: number[]; notes: string[] } {
  const out = blocks.map((b) => ({ ...b }));
  const changed: number[] = [], notes: string[] = [];
  const lv = (id: string) => cards.find((c) => c.id === id)?.level ?? 0;
  for (let i = 0; i < out.length; i++) {
    if (!removed.has(out[i].card) || locked.has(i)) continue;
    const old = out[i];
    const prev = out[i - 1], next = out[i + 1];
    let best: { card: string; bpm: number; cost: number } | null = null;
    for (const c of cards) {
      if (!palette.includes(c.id) || removed.has(c.id)) continue;
      if (prev && c.id === prev.card) continue;
      if (next && c.id === next.card) continue;
      if (prev && c.level > lv(prev.card) + 1) continue;
      if (next && lv(next.card) > c.level + 1) continue;
      const bpm = bpmForCard(c.id, old.bpm, old.n, ctx, c);
      if (bpm == null) continue;
      const cost = Math.abs(c.level - lv(old.card)) + Math.abs(bpm - old.bpm) / old.bpm * 10
                 + out.filter((b) => b.card === c.id).length * 0.3;
      if (!best || cost < best.cost) best = { card: c.id, bpm, cost };
    }
    if (best) { out[i] = { ...old, card: best.card, bpm: best.bpm }; changed.push(i); }
    else notes.push(`${i + 1} 番目の塊（${old.card}）は置き換え先が見つかりませんでした。そのまま残します`);
  }
  return { blocks: out, changed, notes };
}
