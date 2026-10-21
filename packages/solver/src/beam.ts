// beam search。アンカーから伸ばして n 曲の並びを作る。
//
// アンカーは既定で「終曲」。そこから逆向きに組む（plan.md S5 "Backward beam search from anchor track"）。
// DJ の作り方として、締めの 1 曲は決まっていて、そこへどう持っていくかが問題だから。
// anchor_position: "start" にすれば頭から前向きに組む。
//
// 内部は「組んだ順」で持ち、cost はつねに「セットの順」に直してから計算する。

import type { SolverTrack, SetEntry, SetlistCandidate, SolveRequest } from './types.ts';
import { buildTargets, fitCost, pairCost, cheapCost, bpmCompatible, positionAllowed, groupCost, blockCost, venueToneCost, buildBpmPlan, type ScoreConfig } from './score.ts';
import type { Layout } from './blocks.ts';

interface State {
  seq: { t: SolverTrack; eff: number; mult: number; pitch: number; cost: number; flags: string[] }[];  // 組んだ順
  used: Set<string>;
  /** 版違いを落とした曲名。同じ曲の Original / Extended / Remix が並ぶのを防ぐ */
  titles: Set<string>;
  /** アーティストごとの採用数 */
  artists: Map<string, number>;
  /** そのセットで使った音の群れ（g1..g8）。セット全体の性格を保つのに使う */
  seenGroups: Set<string>;
  /** 直前の曲の群。**全曲が必ずどれかの群に入るので「不明」の分岐が要らない** */
  lastGroup: string | null;
  /** 今の塊。cell = 塊の区画(c1..c24)、run = 何曲続いているか */
  lastCell: string | null;
  run: number;
  cost: number;
  /**
   * 使った曲と「その同じ録音（別ファイル）」の印。pool の添字で引く。
   * **伸ばす直前に作る（遅延）。** beam の幅を超えて捨てられる state のぶんまで作ると重い。
   * 以前は候補ごとにセット内の全曲と音色の内積を取っており、52 曲で 40 秒かかった。
   */
  blocked: Uint8Array | null;
  parentBlocked: Uint8Array | null;
}

export interface SolveResult {
  candidates: SetlistCandidate[];
  /** n 曲に届かなかった場合の到達長 */
  reached: number;
  n: number;
  anchor: SolverTrack | null;
  targets: { groove: number[]; energy: number[] };
  notes: string[];
}

const normKey = (s: string) => String(s ?? '').toLowerCase().replace(/[\s_\-()\[\]]/g, '');

/**
 * 曲を探す。**曲名でもアーティスト名でも引ける。**
 *
 * 2026-08-08 に作り直した。それまでは「含まれていれば 2 点」だけで、同点なら
 * 先に見つかった方が勝っていた。そのため「girl friend」で
 * Ariana Grande の "break up with your girlfriend, i'm bored"（BPM 85）を掴んでしまい、
 * 本命の Icona Pop "Girlfriend"（BPM 129）に届かなかった（実害）。
 *
 * 直し方: **一致の質で並べる。** 完全一致 > 前方一致 > 語の切れ目で一致 > ただ含む。
 * 同点なら曲名が短い方（長い曲名の一部にたまたま含まれるだけ、を下げるため）。
 */
export function searchTracks(pool: SolverTrack[], query: string, limit = 20): SolverTrack[] {
  const q = normKey(query);
  if (!q) return [];
  const score = (hay: string, weight: number): number => {
    const h = normKey(hay);
    if (!h.includes(q)) return 0;
    if (h === q) return weight * 100;
    if (h.startsWith(q)) return weight * 50;
    // 語の切れ目で始まっているか（元の文字列で見る。正規化すると切れ目が消えるため）
    if (new RegExp('(^|[\\s\\-_(\\[])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        .test(String(hay).toLowerCase().replace(/[\s_\-()\[\]]/g, (m) => m))) return weight * 20;
    return weight * 10;
  };
  return pool
    .map((t) => {
      let s = Math.max(score(t.title, 1), score(t.basename, 0.9)) + score(t.artist, 0.8);
      if (!s) return { t, s: 0 };
      s += Math.max(0, 20 - t.title.length) * 0.1;   // 短い曲名を少し優先
      return { t, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.t);
}

/**
 * アンカーを 1 曲決める。
 * **その位置で実際に使える曲を優先する**（BPM がセットの計画に届かない曲より、届く曲）。
 * 届く曲が 1 つも無ければ、一致の質が一番高いものを返す（呼び出し側が理由を出せるように）。
 */
function findAnchor(
  pool: SolverTrack[], a: SolveRequest['anchor'], usable?: (t: SolverTrack) => boolean,
): SolverTrack | null {
  if (!a) return null;
  if (a.basename) {
    const hit = pool.find((t) => t.basename === a.basename)
      ?? pool.find((t) => normKey(t.basename).includes(normKey(a.basename!)));
    if (hit) return hit;
  }
  const q = [a.title, a.artist].filter(Boolean).join(' ');
  const hits = searchTracks(pool, q, 50);
  if (!hits.length) return null;
  if (usable) { const ok = hits.find(usable); if (ok) return ok; }
  return hits[0];
}

export interface SolveOptions {
  /** 文脈タグごとの最小位置（config/contexts.json） */
  positionMin?: Record<string, number>;
  /** 箱の色（config/venues.json の tone）= 音の群れの id。外れた群に SOFT な cost が付く */
  tone?: string[] | null;
  /** この曲を使うと cost が増える。別案を作るときに前の案の曲を遠ざけるのに使う */
  penalize?: Set<string>;
  /**
   * **強く避ける曲。** 塊を「選び直す」ときの前の曲。HARD にしないのは、曲の少ない札（ラテン等）で
   * 組めなくなるのを防ぐため。cost は weights.beam.avoid_penalty（既定 5 = ほぼ選ばれない）。
   */
  avoid?: Set<string>;
  /** 位置を固定する曲。setPos(1始まり) -> basename。1 曲差し替えに使う */
  fixed?: Map<number, string>;
  /**
   * 長いセットの塊（blocks.ts）。あれば位置ごとに「その塊の札の曲だけ」を使い、
   * セットの BPM は塊ごと、カットの境目だけ隣との BPM 差を HARD にしない。
   * 塊は明示されているので、音の区画で塊を数える cost（blockCost / groupCost）は使わない。
   */
  layout?: Layout | null;
}

export function solve(pool: SolverTrack[], req: SolveRequest, weights: any, curves: any, opts: SolveOptions = {}): SolveResult {
  const positionMin = opts.positionMin ?? {};
  const penalize = opts.penalize ?? new Set<string>();
  const penalty = Number(weights.beam.diversity_penalty ?? 0);
  const fixed = opts.fixed ?? new Map<number, string>();
  /** その位置に固定された曲か。固定が無ければ全部通す */
  const fixedOk = (t: SolverTrack, setPos: number): boolean => {
    const want = fixed.get(setPos);
    return want == null || t.basename === want;
  };
  const avoid = opts.avoid ?? new Set<string>();
  const avoidCost = Number(weights.beam.avoid_penalty ?? 5);
  const layout = opts.layout ?? null;
  // **締めの塊には「案を散らすための減点」を効かせない。**（2026-10-17）
  // 案 2・案 3 は前の案で使った曲を減点して作るので、案 3 の頃には強い曲が出払い、
  // 締めだけ弱くなっていた（45 案中 3 件、いずれも案 3。山より 0.08-0.14 低い）。
  // 締めは毎回いちばん強い曲で閉じてよい。案の違いは手前の 3/4 で作れば足りる。
  const lastBlockStart = layout?.blocks.length ? layout.blocks[layout.blocks.length - 1].start : Infinity;
  const extraCost = (t: SolverTrack, setPos: number): number =>
    ((penalize.has(t.key) && setPos < lastBlockStart) ? penalty : 0) + (avoid.has(t.key) ? avoidCost : 0);
  const tone = layout ? null : (opts.tone ?? null);
  /** その位置に置いてよい曲か（長いセットの札）。従来版では常に true */
  const allowAt = (t: SolverTrack, setPos: number): boolean => !layout || layout.allowAt(setPos, t);
  /** カットで入る位置か。setPos と、セット順でその直後の位置の間で判定する */
  const isBoundary = (laterPos: number): boolean => !!layout && layout.boundaries.has(laterPos);
  // 1 曲目に置くもの。「レゲエから始めて」用。
  // canonical(reggae) / family(world) / 音の群れの id(g5) のどれで書いてもよい
  const startGenre = req.start_genre ? String(req.start_genre).toLowerCase() : null;
  const startOk = (t: SolverTrack, setPos: number): boolean =>
    setPos !== 1 || !startGenre
    || t.canonical.toLowerCase() === startGenre
    || (t.family ?? '').toLowerCase() === startGenre
    || t.soundGroup.toLowerCase() === startGenre;
  const notes: string[] = [];
  const n = layout ? layout.n : Number(req.n ?? 13);
  const curveName = req.curve ?? curves.default;
  const curve = curves.curves[curveName];
  if (!curve) throw new Error(`未知の curve: ${curveName}（config/curves.json にあるのは ${Object.keys(curves.curves).join(', ')}）`);

  const targets = layout ? layout.targets : buildTargets(curve, n);
  const tol = Number(weights.hard.bpm_tolerance);
  const mults: number[] = weights.hard.bpm_multipliers;
  const band = req.bpm_band ?? null;
  const endBpm = req.end_bpm ?? null;
  const reversed = (req.anchor_position ?? 'end') === 'end';

  if (band && endBpm && (endBpm < band[0] || endBpm > band[1])) {
    notes.push(`end_bpm ${endBpm} が bpm_band [${band[0]}, ${band[1]}] の外にあります。band を優先し、end_bpm は目安としてのみ効かせます`);
  }

  // おまかせ。seed があれば曲ごとに固定の乱数を配る（同じ seed なら毎回同じ結果）
  let jitter: Map<string, number> | null = null;
  if (req.seed != null) {
    let x = (Number(req.seed) | 0) || 1;
    jitter = new Map();
    for (const t of pool) { x = (x * 1103515245 + 12345) & 0x7fffffff; jitter.set(t.key, x / 0x7fffffff); }
  }

  const cfg: ScoreConfig = { weights, targets, n, endBpm, jitter };

  // **セットを回す BPM の計画。** これがあると「そこへピッチで寄せられる曲」から選ぶ方式になる
  const plan = buildBpmPlan(layout ? layout.phases : req.set_bpm);
  const pitchTol = Number(weights.set_bpm?.pitch_tolerance ?? 0.05);

  const inBand = (eff: number) => !band || (eff >= band[0] && eff <= band[1]);

  /**
   * その位置でその曲が使えるか、使えるなら何 BPM で回して原曲から何%ずらすか。
   *
   * セットの BPM を決めているとき: かける BPM は常に計画値。原曲との差がピッチ量になる。
   * 決めていないとき（従来方式）: 原曲の速度（と半速・倍速）そのままで、隣との差だけを見る。
   */
  const effOptions = (t: SolverTrack, setPos: number): { m: number; eff: number; pitch: number }[] => {
    if (!plan) {
      // 等速(x1)を先に試す。倍率は cost が付くので、同じ曲で複数通るなら等速が選ばれてほしい
      return mults.map((m) => ({ m, eff: t.bpm * m, pitch: 0 })).filter((x) => inBand(x.eff))
        .sort((a, b) => Math.abs(a.m - 1) - Math.abs(b.m - 1));
    }
    const target = plan(setPos);
    const out: { m: number; eff: number; pitch: number }[] = [];
    for (const m of mults) {
      const natural = t.bpm * m;
      const pitch = (target - natural) / natural;      // + なら速くする
      if (Math.abs(pitch) <= pitchTol) out.push({ m, eff: target, pitch });
    }
    // ずらす量が小さい順。同じ曲で複数の倍率が通るなら、無理のない方を使う
    return out.sort((a, b) => Math.abs(a.pitch) - Math.abs(b.pitch));
  };

  const buildPos = (j: number) => (reversed ? n - j : j + 1);   // 組んだ順 j (0始まり) -> セット位置 (1始まり)

  // 「同じ曲・同じアーティストが並ぶ」を防ぐ HARD 制約。
  // SOFT は似ているほど cost が下がるので、これが無いと同じ曲の別バージョンが連続する
  // （4000 曲規模の試験で実際に起きた）。
  const allowSameTitle = weights.hard.same_title === true;
  // 長いセットでは同じアーティストの上限を緩める（52 曲で 2 曲までは窮屈）
  const longArtist = weights.hard.max_per_artist_long;
  const maxPerArtist = (longArtist && n >= Number(longArtist.from_tracks)
    ? Number(longArtist.max) : Number(weights.hard.max_per_artist ?? 0)) || Infinity;
  const allowSameArtistAdjacent = weights.hard.same_artist_adjacent === true;
  // 同じ録音が別ファイルで入っている場合、曲名では取りきれない（実データで 692 組）。
  // timbre は L2 正規化済みなので内積がそのまま cosine
  const dupCos = Number(weights.hard.timbre_duplicate_cosine ?? 0);
  const isSameRecording = (a: SolverTrack, b: SolverTrack): boolean => {
    if (!dupCos) return false;
    let dot = 0;
    const n = Math.min(a.timbre.length, b.timbre.length);
    for (let i = 0; i < n; i++) dot += a.timbre[i] * b.timbre[i];
    return dot > dupCos;
  };
  // 同じ録音の判定は「セットに入った曲 1 つにつき pool 全体と 1 回だけ」計算して使い回す
  const poolIdx = new Map<string, number>();
  pool.forEach((t, i) => poolIdx.set(t.key, i));
  const dupRows = new Map<string, Uint8Array>();
  const dupRow = (a: SolverTrack): Uint8Array => {
    let row = dupRows.get(a.key);
    if (!row) {
      row = new Uint8Array(pool.length);
      for (let i = 0; i < pool.length; i++) if (isSameRecording(a, pool[i])) row[i] = 1;
      dupRows.set(a.key, row);
    }
    return row;
  };
  const materialize = (st: State): Uint8Array => {
    if (st.blocked) return st.blocked;
    const row = dupRow(st.seq[st.seq.length - 1].t);
    const b = st.parentBlocked ? Uint8Array.from(st.parentBlocked) : new Uint8Array(pool.length);
    for (let i = 0; i < b.length; i++) b[i] |= row[i];
    st.blocked = b; st.parentBlocked = null;
    return b;
  };
  const repeatOk = (st: State, t: SolverTrack, last: SolverTrack | null): boolean => {
    if (!allowSameTitle && t.titleKey && st.titles.has(t.titleKey)) return false;
    const ti = poolIdx.get(t.key);
    if (ti != null) { if (st.blocked![ti]) return false; }
    else for (const e of st.seq) if (isSameRecording(e.t, t)) return false;
    for (const a of t.artistNames) {
      if ((st.artists.get(a) ?? 0) >= maxPerArtist) return false;
      if (!allowSameArtistAdjacent && last && last.artistNames.includes(a)) return false;
    }
    return true;
  };
  const extend = (st: State, t: SolverTrack, eff: number, mult: number, pitch: number, cost: number, flags: string[],
                  block: { cell: string | null; run: number }): State => {
    const artists = new Map(st.artists);
    for (const a of t.artistNames) artists.set(a, (artists.get(a) ?? 0) + 1);
    const seenGroups = new Set(st.seenGroups);
    if (t.soundGroup) seenGroups.add(t.soundGroup);
    return {
      seq: [...st.seq, { t, eff, mult, pitch, cost, flags }],
      used: new Set(st.used).add(t.key),
      titles: new Set(st.titles).add(t.titleKey),
      artists, seenGroups,
      lastGroup: t.soundGroup || st.lastGroup,
      lastCell: block.cell, run: block.run,
      cost: st.cost + cost,
      blocked: null, parentBlocked: st.blocked,
    };
  };

  // --- シード ---
  const seedPos = buildPos(0);
  // **その位置で実際に使える曲を優先して選ぶ。** 名前が似ているだけで BPM が届かない曲を
  // 黙って掴むと、2 秒待たせた末に「組めません」になる（2026-08-08 の実害）
  const anchor = findAnchor(pool, req.anchor, (t) => allowAt(t, seedPos) && effOptions(t, seedPos).length > 0);
  if (req.anchor && !anchor) notes.push('アンカーがプールに見つかりませんでした。制約に合う曲から自動で選びます');
  if (anchor && effOptions(anchor, seedPos).length === 0) {
    // 見つかったが使えない。**理由を BPM の数字で言う。**「bpm_band が厳しすぎる可能性」では分からない
    const target = plan ? plan(seedPos) : null;
    const tried = mults.map((m) => `x${m} = ${(anchor.bpm * m).toFixed(1)}`).join(' / ');
    notes.push(
      `「${anchor.title}」は原曲 ${anchor.bpm.toFixed(1)} BPM で、` +
      (target != null
        ? `セットの ${target.toFixed(0)} BPM に ±${(pitchTol * 100).toFixed(0)}% では届きません（${tried}）。`
        : `指定した BPM 帯 ${band ? `${band[0]}-${band[1]}` : ''} の外です（${tried}）。`) +
      ' 帯を広げるか、別の曲を締めにしてください');
  }

  let states: State[] = [];
  const seedFrom = anchor ? [anchor] : pool;
  for (const t of seedFrom) {
    if (!positionAllowed(t, seedPos, positionMin)) continue;
    if (!fixedOk(t, seedPos)) continue;
    if (!startOk(t, seedPos)) continue;
    if (!allowAt(t, seedPos)) continue;
    for (const { m, eff, pitch } of effOptions(t, seedPos)) {
      const c = fitCost(t, seedPos, eff, m, cfg, pitch) + extraCost(t, seedPos) + venueToneCost(t, tone, cfg);
      states.push({
        seq: [{ t, eff, mult: m, pitch, cost: c, flags: [] }],
        used: new Set([t.key]), titles: new Set([t.titleKey]),
        artists: new Map(t.artistNames.map((a) => [a, 1] as [string, number])),
        seenGroups: new Set(t.soundGroup ? [t.soundGroup] : []),
        lastGroup: t.soundGroup || null,
        lastCell: t.soundCell || null, run: 1,
        cost: c,
        blocked: null, parentBlocked: null,
      });
    }
  }
  states.sort((a, b) => a.cost - b.cost);
  const width = Number(weights.beam.width);
  const perStep = Number(weights.beam.candidates_per_step);
  states = states.slice(0, anchor ? mults.length : Math.max(width * 4, 40));

  if (!states.length) return { candidates: [], reached: 0, n, anchor, targets, notes: [...notes, 'シードが 1 つも作れませんでした（bpm_band が厳しすぎる可能性）'] };

  // --- 伸ばす ---
  let reached = 1;
  // **固定した曲を先に勘定に入れる。** 固定曲はまだ組んでいない位置にあっても、同じ曲・同じ録音・
  // アーティストの回数を先に使っている。これを見ないと、空いた位置で同じアーティストを上限まで使い、
  // あとで固定曲が置けなくなる（長いセットの「ここまで確定」で実際に起きた）
  const fixedTracks = new Map<number, SolverTrack>();
  for (const [p, bn] of fixed) { const t = pool.find((x) => x.basename === bn); if (t) fixedTracks.set(p, t); }
  /** setPos に置く曲 t が、まだ組んでいない位置の固定曲とぶつからないか */
  const reservedOk = (t: SolverTrack, setPos: number, st: State): boolean => {
    if (!fixedTracks.size || fixed.has(setPos)) return true;
    const ti = poolIdx.get(t.key);
    for (const [p, f] of fixedTracks) {
      if (reversed ? p >= setPos : p <= setPos) continue;          // もう組んだ位置
      if (st.used.has(f.key)) continue;
      if (f.key === t.key) return false;
      if (!allowSameTitle && t.titleKey && f.titleKey === t.titleKey) return false;
      if (ti != null && dupRow(f)[ti]) return false;
      // 隣が固定曲なら、同じアーティストを並べない
      if (!allowSameArtistAdjacent && Math.abs(p - setPos) === 1 && f.artistNames.some((a) => t.artistNames.includes(a))) return false;
    }
    for (const a of t.artistNames) {
      let c = st.artists.get(a) ?? 0;
      for (const [p, f] of fixedTracks) {
        if ((reversed ? p < setPos : p > setPos) && !st.used.has(f.key) && f.artistNames.includes(a)) c++;
      }
      if (c >= maxPerArtist) return false;
    }
    return true;
  };

  for (let j = 1; j < n; j++) {
    const setPos = buildPos(j);
    const next: State[] = [];
    // セット順で後ろ側の位置。境目はこちらが章の 1 曲目かどうかで決まる
    const laterPos = reversed ? setPos + 1 : setPos;
    const cut = isBoundary(laterPos);
    for (const st of states) {
      const last = st.seq[st.seq.length - 1];
      materialize(st);

      // 安いスコアで候補を絞ってから音色距離を計算する（3961 曲でも実用速度を保つため）
      const feasible: { t: SolverTrack; m: number; eff: number; pitch: number; cheap: number }[] = [];
      for (const t of pool) {
        if (st.used.has(t.key)) continue;
        if (!positionAllowed(t, setPos, positionMin)) continue;
        if (!fixedOk(t, setPos)) continue;
        if (!startOk(t, setPos)) continue;
        if (!allowAt(t, setPos)) continue;
        if (!repeatOk(st, t, last.t)) continue;
        if (!reservedOk(t, setPos, st)) continue;
        for (const { m, eff, pitch } of effOptions(t, setPos)) {
          // セットの BPM を決めているときも、区間の切り替わり（126 -> 129）は隣接判定にかかる。
          // 切り替え幅が大きすぎないかをここで見ている
          // 長いセットのカットの境目は、切り替えで BPM を変える前提（ユーザー指示 2026-10-16）。HARD にしない
          if (!cut && !bpmCompatible(last.eff, eff, tol)) continue;
          feasible.push({ t, m, eff, pitch, cheap: cheapCost(t, setPos, cfg) });
          break;   // 同じ曲で複数倍率が通るなら 1 つで足りる（無理の小さい方。上でソート済み）
        }
      }
      feasible.sort((a, b) => a.cheap - b.cheap);
      // 固定した曲は「安いスコアで上位 N 件」の切り捨てで消えてはいけない
      const slice = fixed.has(setPos) ? feasible : feasible.slice(0, perStep);

      for (const c of slice) {
        // セットの順に直してから対の cost を計算する
        const [prev, nextT, prevEff, nextEff] = reversed
          ? [c.t, last.t, c.eff, last.eff]
          : [last.t, c.t, last.eff, c.eff];
        const pair = pairCost(prev, nextT, prevEff, nextEff, cfg, cut);
        // 長いセットは塊（札）を明示しているので、音の区画で塊を数える cost は使わない
        const block = layout ? { cost: 0, cell: c.t.soundCell || null, run: 1 } : blockCost(c.t, st.lastCell, st.run, cfg);
        const fit = fitCost(c.t, setPos, c.eff, c.m, cfg, c.pitch) + extraCost(c.t, setPos)
                  + (layout ? 0 : groupCost(c.t, st.lastGroup, st.seenGroups, cfg))
                  + venueToneCost(c.t, tone, cfg) + block.cost;
        next.push(extend(st, c.t, c.eff, c.m, c.pitch, pair.cost + fit, pair.flags, block));
      }
    }
    if (!next.length) {
      notes.push(`${reached} 曲目までしか繋がりませんでした。BPM ±${(tol * 100).toFixed(0)}% と重複制限を満たす曲がプールに残っていません`);
      break;
    }
    next.sort((a, b) => a.cost - b.cost);
    states = next.slice(0, width);
    reached = j + 1;
  }

  // --- 上位候補を選ぶ（似すぎている並びは 1 つにまとめる） ---
  const maxOverlap = Number(weights.beam.max_overlap);
  const wanted = Number(weights.beam.outputs);
  const picked: State[] = [];
  for (const st of states) {
    const dup = picked.some((p) => {
      const shared = [...st.used].filter((k) => p.used.has(k)).length;
      return shared / st.used.size > maxOverlap;
    });
    if (!dup) picked.push(st);
    if (picked.length >= wanted) break;
  }
  if (!picked.length) picked.push(states[0]);

  const candidates: SetlistCandidate[] = picked.map((st) => {
    const ordered = reversed ? [...st.seq].reverse() : st.seq;
    const entries: SetEntry[] = ordered.map((s, i) => ({
      track: s.t, position: i + 1, effectiveBpm: s.eff, multiplier: s.mult, pitch: s.pitch,
      transitionCost: 0, flags: [],
      ...(layout ? { block: layout.blockAt(i + 1) } : {}),
    }));
    // フラグと遷移 cost はセットの順で付け直す。「この曲に入るところが要注意」と読める向きに揃えるため
    // （逆算で組んでいるので、探索中は 1 つ手前の曲に付いてしまう）
    for (let i = 1; i < entries.length; i++) {
      const p = pairCost(entries[i - 1].track, entries[i].track, entries[i - 1].effectiveBpm, entries[i].effectiveBpm, cfg, isBoundary(i + 1));
      entries[i].transitionCost = p.cost;
      entries[i].flags = p.flags;
    }
    return {
      entries, totalCost: st.cost,
      manualChecks: entries.filter((e) => e.flags.includes('MANUAL_CHECK')).length,
    };
  });

  return { candidates, reached, n, anchor, targets, notes };
}


/**
 * 案を複数作る。beam の上位をそのまま並べても中身が 8-9 割同じになるため、
 * **1 案ずつ解き直して、前の案で使った曲に cost を足す**。
 * 「いくつか提案してほしい」に応えるには、順位の 2 番目ではなく別物が要る。
 *
 * 3 案で solve を 3 回呼ぶ。3961 曲でも 1 回 100ms 程度なので実用上問題ない。
 */
export function solveMany(
  pool: SolverTrack[], req: SolveRequest, weights: any, curves: any,
  opts: SolveOptions = {},
  /**
   * 案ごとに曲数を決め直す（持ち時間に合わせる。cli.ts の fitMinutes）。
   * 目的関数には触らず、**曲数だけ**を変えて同じ条件で解き直させる
   */
  adjust?: (first: SolveResult, solveAt: (n: number) => SolveResult) => SolveResult,
): { results: SolveResult[]; overlaps: number[] } {
  const wanted = Number(weights.beam.outputs ?? 3);
  const results: SolveResult[] = [];
  const overlaps: number[] = [];
  const penalize = new Set<string>(opts.penalize ?? []);

  for (let i = 0; i < wanted; i++) {
    let r = solve(pool, req, weights, curves, { ...opts, penalize });
    if (adjust) r = adjust(r, (n) => solve(pool, { ...req, n }, weights, curves, { ...opts, penalize }));
    const cand = r.candidates[0];
    if (!cand) {
      // 1 案も作れなかったときも、なぜ作れなかったか（notes）を呼び出し元に渡す
      if (!results.length) { results.push(r); overlaps.push(0); }
      break;
    }
    if (results.length) {
      // 直前までの案とどれだけ曲が重なったか（0 = 全部違う, 1 = 同じ）
      const prev = new Set(results.flatMap((x) => x.candidates[0].entries.map((e) => e.track.key)));
      const share = cand.entries.filter((e) => prev.has(e.track.key)).length / cand.entries.length;
      overlaps.push(share);
      // 全部同じなら、それ以上ひねっても新しい案は出ない
      if (share >= 1) break;
    } else overlaps.push(0);
    results.push(r);
    // 位置を固定している曲は penalize しない（--drop で確定済みの前半が押し出されるのを防ぐ）
    const fixedNames = new Set((opts.fixed ? [...opts.fixed.values()] : []));
    for (const e of cand.entries) if (!fixedNames.has(e.track.basename)) penalize.add(e.track.key);
  }
  return { results, overlaps };
}
