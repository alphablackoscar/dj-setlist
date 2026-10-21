// プール構築 = features.db（生の特徴量）+ collection.xml（TrackID とパス）→ SolverTrack[]。
// 読むだけ。features.db を書き換えるのは Windows だけ（.claude/CLAUDE.md 役割分担）。
//
// ここで導出値（energy / groove）を作る。プール内の順位で 0-1 化するので、
// 対象を絞れば絞ったなかでの相対値になる。50 曲の試験プールと 3961 曲の本番で
// 絶対値が変わるのは意図どおり（S6 で重みを合わせ直す前提）。

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { basename as pathBasename } from 'node:path';
import { dropContrast, toF32 } from './drop.ts';
import type { SolverTrack } from './types.ts';
import { f32, grooveRaw, BAND_LEN } from './groove.ts';
import { parseCamelot, fromKeyScale, formatCamelot, camelotDistance } from './camelot.ts';

/**
 * アーティスト欄を 1 人ずつに分ける。"Daddy Yankee feat. Wisin" -> ["daddy yankee", "wisin"]。
 * **回数と連続の判定は 1 人ずつで数える**（2026-10-16 ユーザー承認）。以前は欄全体を 1 つの名前として
 * 数えていたので、「Daddy Yankee feat. ○○」が別人扱いになり、1 時間のセットに 4 曲入った。
 */
export function artistNamesOf(raw: string): string[] {
  return [...new Set(raw.toLowerCase()
    .split(/[,&/]|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?|\bx\b/)
    .map((x) => x.replace(/[()\[\]]/g, '').trim()).filter(Boolean))];
}

export function trackKey(size: number, basename: string): string {
  return String(size) + '|' + basename;
}

/**
 * 版の違いを落とした曲名。"Sweat (Guz Remix)" と "Sweat (Extended Mix)" を同じ曲と見なすため。
 * 落としすぎて別の曲まで同一視すると候補が減るので、括弧の中と定型語だけを削る。
 */
export function titleKeyOf(title: string, basename: string): string {
  const k = (title || basename)
    .toLowerCase()
    // **先頭のキー表記・曲番号を最初に落とす。** 2026-10-21 に順序を直した。
    //
    // ここが `\s-\s` の処理より後ろにあったため、`6A - Japafunk (Extended Mix)` の鍵が
    // **`"6a"`** になっていた（曲名が丸ごと消え、キー表記が曲の身元になっていた）。
    // 実測した被害（4111 曲）: **295 曲 / 30 グループ**。
    // `6A - …` の 46 曲が全部「同じ曲」扱いで、1 曲使うと残り 45 曲がセットから排除されていた。
    // `F_Happier - KENTO Remix` は `"fhappier"` になり、`Happier - Hugo Doche Remix`（`"happier"`）
    // と別物と判定されて**同じ曲の 2 つのリミックスが 1 つのセットに入った**
    // （2026-10-21 ユーザー報告）。
    //
    // 落とす形: `6A - ` / `12b.` / `F_` / `D#_` / `Am - `。
    // **区切りは `-` `_` `.` だけにする。** 空白を区切りに含めると `B Set Mix` が
    // `Set Mix` に化けるなど、曲名の頭文字を食う。
    .replace(/^\s*(?:\d{1,2}[ab]?|[a-g](?:#|b)?m?)\s*[-_.]\s*/u, ' ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')                                   // (Original Mix) [Extended]
    .replace(/\s-\s.*$/, ' ')                                                // "GO - Showtek Edit" の " - " 以降
    .replace(/\bfeat\.?\b.*$|\bft\.?\b.*$/g, ' ')                            // feat. 以降
    .replace(/\b(extended|original|radio|club|intro|outro|dirty|clean|short|long|edit|mix|remix|rmx|version|ver|bootleg|mashup|vip)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return k || (title || basename).toLowerCase();
}

/** 順位ベースの 0-1 正規化。外れ値に強く、分布の形に依存しない */
function percentileRank(values: (number | null)[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).filter((x) => x.v != null) as { v: number; i: number }[];
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0.5);   // 欠損は中央値扱い
  const n = idx.length;
  for (let r = 0; r < n; r++) out[idx[r].i] = n > 1 ? r / (n - 1) : 0.5;
  return out;
}

interface XmlInfo { trackId: string; path: string; }

/** collection.xml から size|basename -> {TrackID, Location} を引く表を作る（属性だけ拾う。依存を足さない） */
function loadXmlIndex(xmlPath: string): Map<string, XmlInfo> {
  const map = new Map<string, XmlInfo>();
  if (!existsSync(xmlPath)) return map;
  const xml = readFileSync(xmlPath, 'utf8');
  const start = xml.indexOf('<COLLECTION');
  const end = xml.indexOf('</COLLECTION>');
  const source = start >= 0 && end > start ? xml.slice(start, end) : xml;
  const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  const unesc = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
  for (const m of source.matchAll(/<TRACK\s([^>]*?)\/?>/g)) {
    const tag = m[0];
    const at = (name: string) => { const r = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return r ? unesc(r[1]) : ''; };
    const loc = at('Location');
    if (!loc) continue;
    let p = loc.replace(/^file:\/\/localhost/, '').replace(/^file:\/\//, '');
    try { p = decodeURIComponent(p); } catch { /* 壊れたエンコードはそのまま */ }
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    const size = Number(at('Size') || 0);
    map.set(trackKey(size, pathBasename(p)), { trackId: at('TrackID'), path: p });
  }
  return map;
}

function loadJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** config/sound_groups.json の中心点。曲の割り当てはここから毎回計算する */
interface SoundCentroid { id: string; label?: string; vec: Float32Array; }

/**
 * 中心点を読む。**曲ごとの割り当てはファイルに入っていない。**
 * 「一番近い中心点」をここで計算するので、**新しく足した曲も自動でどこかの群に入る**
 * （sound-groups.js を再実行しなくてよい）。
 */
function loadSoundGroups(configDir: string): { groups: SoundCentroid[]; cells: SoundCentroid[]; meta: any } {
  try {
    const j = loadJson(`${configDir}/sound_groups.json`);
    const conv = (list: any[]): SoundCentroid[] => (list ?? []).map((g: any) => ({
      id: String(g.id), label: g.label ? String(g.label) : undefined, vec: Float32Array.from(g.centroid ?? []),
    })).filter((g) => g.vec.length > 0);
    return { groups: conv(j.groups), cells: conv(j.cells), meta: j };
  } catch {
    return { groups: [], cells: [], meta: null };   // 無ければ群を使わない（従来どおり動く）
  }
}

/** 一番近い中心点の id。timbre も centroid も L2 正規化済みなので内積が最大のものが最近傍 */
function nearest(timbre: Float32Array, centroids: SoundCentroid[]): string {
  let best = -Infinity, id = '';
  for (const c of centroids) {
    let d = 0;
    const n = Math.min(timbre.length, c.vec.length);
    for (let i = 0; i < n; i++) d += timbre[i] * c.vec[i];
    if (d > best) { best = d; id = c.id; }
  }
  return id;
}

export interface PoolOptions {
  dbPath: string;
  xmlPath?: string;
  configDir: string;
  /** 使う canonical ジャンル。null なら「excludeGenres 以外すべて」 */
  genres?: string[] | null;
  /** family（9 分類）でまとめて選ぶ近道。genres との和になる */
  families?: string[] | null;
  /** 音の群れで選ぶ（g1..g8）。genres/families とは別系統で、併用すると AND */
  groups?: string[] | null;
  /** アニソンの扱い。exclude=入れない / include=入れる / only=アニソンだけ */
  anime?: 'exclude' | 'include' | 'only';
  /** ジャンル欄が空の曲を含めるか。既定 true */
  includeUntagged?: boolean;
  /** 選択に関わらず外す canonical ジャンル（context の既定。例: nightclub の soundtrack） */
  excludeGenres?: string[];
  /** この語を含む曲だけを使う（Artist / Name / Album / basename のどこかに含まれれば採用） */
  only?: string[] | null;
  /** basename で除外 */
  exclude?: string[];
  /** この文脈タグが付いた曲をプールから完全に外す（ジャンル欄が空の取りこぼしを拾う網） */
  excludeTags?: string[];
  /**
   * **ドロップの落差の上限(dB)。** これを超える曲をプールから外す。
   *
   * 用途は「浅い時間の DJ」。静かなブレイクから一気に爆発する曲は、
   * カフェ利用の客が話せなくなるので不向き、という講師の指摘に対応する。
   * **講師によって線引きが割れる論点**なので、しきい値は config/UI から動かす前提。
   * null なら効かない（既定）。落差は毎回 env_rms/env_low から計算する導出値で、
   * DB には書かない（Hard Constraint 3）。
   */
  maxDropDb?: number | null;
}

/**
 * **つなぎ用の曲の from→to を題名から読む。** `100-125 Transition` / `80-128 Transition` の形。
 *
 * 数字だけを見ると普通の曲の題名（`Blink-182` / `1-800` など）に当たるので、
 * **transition タグが付いた曲にだけ使う**（呼び出し側で保証する）。
 * 2 つの数字が同じか、どちらかが 60-220 の外なら「読めなかった」扱いにする。
 */
export function parseTransitionBpm(text: string): { from: number | null; to: number | null } {
  const m = text.match(/(?<![\d.])(\d{2,3})\s*-\s*(\d{2,3})(?![\d.])/);
  if (!m) return { from: null, to: null };
  const from = Number(m[1]), to = Number(m[2]);
  const ok = (v: number) => v >= 60 && v <= 220;
  if (!ok(from) || !ok(to) || from === to) return { from: null, to: null };
  return { from, to };
}

export interface Pool {
  tracks: SolverTrack[];
  /**
   * **つなぎ用の曲（Transition）。** `tracks` には入れない（単体ではかけられないため）。
   * ✂ の所に挿し込むときだけ使う。title から from→to が読めなかった曲も含む（挿し込みでは使わない）。
   */
  transitions: SolverTrack[];
  /** 読めたが solver に使えなかった曲とその理由 */
  dropped: { basename: string; reason: string }[];
  analyzerVersion: string;
  /** この DB に無かった列。energy の材料が欠けていれば警告に使う */
  missingColumns: string[];
  /** 音の群れの定義（id -> 表示名）。--list-groups と画面の選択 UI に出す */
  soundGroupLabels: { id: string; label: string }[];
}

export function buildPool(opts: PoolOptions): Pool {
  const weights = loadJson(`${opts.configDir}/weights.json`);
  const genreMap: Record<string, string> = loadJson(`${opts.configDir}/genre_map.json`);
  const familyCfg = loadJson(`${opts.configDir}/genre_family.json`);
  const excludeCfg = loadJson(`${opts.configDir}/exclude_list.json`);

  // canonical -> family の逆引き
  const canonToFamily = new Map<string, string>();
  for (const [fam, list] of Object.entries(familyCfg.families as Record<string, string[]>)) {
    for (const c of list) canonToFamily.set(c, fam);
  }

  // タグ判定。語（Artist/Name/Album/Location）とジャンルのどちらかに当たればタグが付く。
  // 片方だけでは取りこぼす（exclude_list.json の _comment に実測値）
  const contextTags = (excludeCfg.context_tags ?? []).map((t: any) => ({
    tag: String(t.tag),
    re: t.regex ? new RegExp(t.regex, 'i') : null,
    genreRe: t.genre_regex ? new RegExp(t.genre_regex, 'i') : null,
  }));

  // 推測したジャンル系統（あれば）。ジャンル欄が空の曲だけに使う。
  // features.db には書かない方針なので別ファイル（scripts/s5-solver/infer-genre.js が生成）
  let inferred: Record<string, { family: string; confidence: number }> = {};
  try { inferred = loadJson(`${opts.configDir}/genre_inferred.json`).tracks ?? {}; } catch { /* 無ければ使わない */ }

  // 音の群れ。**並べるときの判断はすべてこちらを使う**（ジャンルのテキストは選ぶときだけ）
  const sound = loadSoundGroups(opts.configDir);

  const xmlIndex = opts.xmlPath ? loadXmlIndex(opts.xmlPath) : new Map<string, XmlInfo>();

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  // 欲しい列のうち、その DB に実在するものだけを SELECT する。
  // analyzer のバージョンによって列が増えるため（例: danceability_logit は 0.4.0 から）、
  // 決め打ちすると古い DB を開いた瞬間に "no such column" で落ちる。
  const have = new Set((db.prepare('PRAGMA table_info(tracks)').all() as any[]).map((r) => String(r.name)));
  const want = [
    'size', 'basename', 'track_id', 'title', 'artist', 'genre', 'xml_bpm', 'xml_key', 'duration',
    'analyzer_version', 'bpm_measured', 'bpm_confidence', 'key', 'scale',
    'rms', 'spectral_centroid', 'flux', 'zcr', 'valence', 'arousal',
    'danceability_dsp', 'danceability_ml', 'danceability_logit', 'low_energy_ratio', 'key_strength',
    'band_curves', 'beat_ticks', 'embedding', 'window_start',
  ];
  // 曲まるごとの起伏（FEATURE_SPEC §4.7）は **落差で絞るときだけ**読む。
  // 常に読むと 3970 曲で +2.6 秒かかり、使わない人まで待たされる（実測）。
  // 古い DB には列が無いが、have で弾かれるので古い DB でも落ちない。
  const useDrop = opts.maxDropDb != null;
  if (useDrop) want.push('env_rms', 'env_low');
  const missing = want.filter((c) => !have.has(c));
  const rows = db.prepare(
    `SELECT ${want.filter((c) => have.has(c)).join(', ')} FROM tracks WHERE status = 'done'`).all() as any[];
  db.close();

  const versions = [...new Set(rows.map((r) => String(r.analyzer_version)))];
  const dropped: { basename: string; reason: string }[] = [];
  const excludeSet = new Set(opts.exclude ?? []);
  const confMin = weights.bpm_confidence_min?.value ?? 1.0;

  // --- 1 パス目: 使える曲だけ残して生値を集める ---
  interface Raw { row: any; bpm: number; bpmSource: 'measured' | 'xml'; groove: number; timbre: Float32Array; flags: string[]; dropDb: number | null; }
  const raws: Raw[] = [];
  for (const r of rows) {
    const bn = String(r.basename);
    if (excludeSet.has(bn)) { dropped.push({ basename: bn, reason: 'request の exclude' }); continue; }

    const flags: string[] = [];
    const measured = r.bpm_measured != null ? Number(r.bpm_measured) : null;
    const xmlBpm = r.xml_bpm != null ? Number(r.xml_bpm) : null;
    const conf = r.bpm_confidence != null ? Number(r.bpm_confidence) : 0;

    // **信頼度が低くても bpm_measured を優先する。**
    // 対照 50 曲で確認: XML の AverageBpm は 4 曲で実測のちょうど 2 倍（hip-hop を 200 と表記など）、
    // 信頼度 0.55 の曲でも XML 210 / 実測 140 で実測の方が妥当だった。
    // XML に落とす方が事故る。XML は bpm_measured が無いときの最後の手段にとどめる。
    const bpm: number | null = measured ?? xmlBpm;
    const bpmSource: 'measured' | 'xml' = measured != null ? 'measured' : 'xml';
    if (bpm == null || !(bpm > 0)) { dropped.push({ basename: bn, reason: 'BPM が取れていない' }); continue; }

    if (conf < confMin) flags.push('BPM_LOW_CONF');
    // XML と実測が、倍・半を許してもなお食い違う曲。どちらかが外れている
    if (measured != null && xmlBpm != null && xmlBpm > 0) {
      const off = Math.min(...[0.5, 1, 2].map((m) => Math.abs(xmlBpm * m - measured) / measured));
      if (off > Number(weights.hard.bpm_tolerance)) flags.push('BPM_CHECK');
    }

    const bc = f32(r.band_curves), bt = f32(r.beat_ticks);
    const g = grooveRaw(bc, bt, r.duration != null ? Number(r.duration) : null);
    if (g == null) {
      // **理由を分けて言う。** 以前は何で落ちても「列が無い（analyzer < 0.2.0）」と
      // 出していたが、実データ 3993 曲の列は全部埋まっていて、実際に落ちていた 3 曲は
      // 1.9 秒のサンプル音源（拍が 3 つしかない）だった。理由が違うと直し方を間違える
      // （2026-10-03）。
      const noCols = !bc || !bt || bc.length < BAND_LEN;
      dropped.push({
        basename: bn,
        reason: noCols
          ? 'band_curves / beat_ticks が無い（analyzer < 0.2.0 の DB）'
          : `拍が足りない（${bt ? bt.length : 0} 拍 / ${r.duration != null ? Number(r.duration).toFixed(1) : '?'} 秒。サンプル音源など短すぎる曲）`,
      });
      continue;
    }

    const emb = f32(r.embedding);
    if (!emb || emb.length === 0) { dropped.push({ basename: bn, reason: 'embedding が無い' }); continue; }
    // L2 正規化しておくと cosine が内積だけで済む
    let norm = 0; for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
    norm = Math.sqrt(norm) || 1;
    const timbre = new Float32Array(emb.length);
    for (let i = 0; i < emb.length; i++) timbre[i] = emb[i] / norm;

    // ドロップの落差。**落差で絞るときだけ計算する。** 起伏を持たない曲
    //（古い DB / --envelope 未実行）は null のままで、絞り込みからは素通しする
    //（知らないものを勝手に外さない）
    let dropDb: number | null = null;
    if (useDrop) {
      const envRms = toF32(r.env_rms), envLow = toF32(r.env_low);
      if (envRms && envLow) dropDb = dropContrast(envRms, envLow, Number(r.duration ?? 0)).db;
    }

    raws.push({ row: r, bpm, bpmSource, groove: g, timbre, flags, dropDb });
  }

  // --- 2 パス目: プール内の順位で 0-1 化する ---
  const ef: Record<string, number> = Object.fromEntries(
    Object.entries(weights.energy_features as Record<string, any>).filter(([k, v]) => !k.startsWith('_') && typeof v === 'number'));
  const ranks: Record<string, number[]> = {};
  for (const feat of Object.keys(ef)) ranks[feat] = percentileRank(raws.map((x) => (x.row[feat] != null ? Number(x.row[feat]) : null)));
  const grooveRank = percentileRank(raws.map((x) => x.groove));
  const wSum = Object.values(ef).reduce((a, b) => a + b, 0) || 1;

  const tracks: SolverTrack[] = raws.map((x, i) => {
    const r = x.row;
    const bn = String(r.basename);
    const size = Number(r.size);
    const canonical = genreMap[String(r.genre ?? '')] ?? '';
    const canon = canonical === 'EXCLUDE' ? '' : canonical;
    let family = canon ? (canonToFamily.get(canon) ?? 'other') : null;
    // ジャンル欄が空の曲は、音色から推測した系統で埋める（あれば）
    let familyGuessed = false;
    if (!family) {
      const g = inferred[trackKey(size, bn)];
      if (g?.family) { family = g.family; familyGuessed = true; }
    }

    const camelotC = parseCamelot(r.xml_key);
    const camelotEstC = fromKeyScale(r.key ?? null, r.scale ?? null);
    const camelot = formatCamelot(camelotC);
    const camelotEst = formatCamelot(camelotEstC);
    // **食い違っていても、2 つの読みが時計の隣どうしなら繋ぎ方は変わらない。**
    // どちらが正しくても隣接は保たれるので、人に確かめさせる意味が無い。
    // 距離 2 以上のときだけ「このキーを信じて並べた結果が変わりうる」ので印を立てる。
    // （実測 2026-10-17: 全曲に対し 距離1 = 16.5%（平行調など）/ 距離2以上 = 18.8%。
    //   以前は両方立てていたので 35.3% に印が付き、画面で意味を失っていた）
    const keyAgrees = camelot != null && camelotEst != null && camelot === camelotEst;
    const keyFar = (camelotDistance(camelotC, camelotEstC) ?? 0) >= 2;
    const flags = [...x.flags];
    // GENRE_GUESS は表示しない。**推測したジャンルは並べる判断に一切使わなくなった**ため
    // （並びは音の群れで決まる）。familyGuessed が残っているのは --families で選ぶときの
    // 絞り込みにだけ効かせるため。全曲に付く印は読み手の注意を無駄に使う。
    if (camelot && camelotEst && keyFar) flags.push('KEY_CHECK');
    if (!camelot) flags.push('KEY_MISSING');

    const xi = xmlIndex.get(trackKey(size, bn));
    const hay = `${r.artist ?? ''} ${r.title ?? ''} ${xi?.path ?? bn}`;
    const genre = String(r.genre ?? '');
    const tags = contextTags
      .filter((t: any) => (t.re && t.re.test(hay)) || (t.genreRe && t.genreRe.test(genre)))
      .map((t: any) => t.tag);

    let energy = 0;
    for (const [feat, w] of Object.entries(ef)) energy += ranks[feat][i] * w;
    energy /= wSum;

    return {
      size, basename: bn, key: trackKey(size, bn),
      trackId: (r.track_id ? String(r.track_id) : null) ?? xi?.trackId ?? null,
      title: String(r.title ?? bn), artist: String(r.artist ?? ''),
      titleKey: titleKeyOf(String(r.title ?? ''), bn),
      // "MAKJ & M35" と "MAKJ, M35" を同じと見なすため、区切って並べ替えてから繋ぐ
      artistKey: artistNamesOf(String(r.artist ?? '')).slice().sort().join('|'),
      artistNames: artistNamesOf(String(r.artist ?? '')),
      path: xi?.path ?? null, duration: Number(r.duration ?? 0),
      genre: String(r.genre ?? ''), canonical: canon, family, familyGuessed,
      // **アニソンかどうかは音では割れない**（実測: 群 g8 の 24% がアニメ系。
      // J-POP のダンス曲とアニソンのダンス曲は作りが同じ）。だから別の軸として持つ。
      // 判定は「ジャンルが soundtrack」または「anime タグ」の OR（片方だけだと取りこぼす）
      isAnime: canon === 'soundtrack' || tags.includes('anime'),
      // **ジャンルのテキストを一切見ずに、音色だけで決まる。だから空になることがない**
      soundGroup: nearest(x.timbre, sound.groups),
      soundCell: nearest(x.timbre, sound.cells),
      bpm: x.bpm, bpmSource: x.bpmSource, bpmConfidence: r.bpm_confidence != null ? Number(r.bpm_confidence) : 0,
      camelot, camelotEstimated: camelotEst, keyAgrees,
      windowStart: r.window_start != null ? Number(r.window_start) : null,
      dropDb: x.dropDb,
      energy, groove: grooveRank[i], grooveRaw: x.groove,
      timbre: x.timbre, contextTags: tags, flags,
      // つなぎ用の曲。from→to は題名から読む（タグが付いた曲にだけ効かせる。数字だけ見ると誤爆する）
      transition: tags.includes('transition')
        ? parseTransitionBpm(`${r.title ?? ''} ${bn}`) : null,
    };
  });

  // --- 絞り込み。順番に落とす ---
  //
  // 1. ジャンル選択（主役）。「選ばなかったジャンルは使わない」という形にする。
  // 2. ジャンル欄が空の曲。ライブラリの 34% を占めるので別扱いにしてある。
  // 3. 文脈タグ。ジャンル欄が空でアニメだった曲など、1 と 2 の取りこぼしを拾う網。
  //
  // 3 が残っている理由: ジャンルを選ぶだけでは、ジャンル欄が空のアニメ曲 3 曲が
  // 「空欄を含める」設定のときにすり抜ける（実測 3961 曲）。

  // 選ばれた canonical の集合。genres と families の和
  let allowed: Set<string> | null = null;
  if (opts.genres?.length || opts.families?.length) {
    allowed = new Set(opts.genres ?? []);
    for (const fam of opts.families ?? []) {
      for (const [canon, f] of canonToFamily) if (f === fam) allowed.add(canon);
    }
  }
  const excludeGenres = new Set(opts.excludeGenres ?? []);
  // ジャンルを明示的に選んだなら、ジャンル欄が空の曲は入れない（選んだつもりが 1338 曲混ざるのを防ぐ）。
  // 何も選んでいないなら入れる。include_untagged を明示すればその指定が勝つ。
  const includeUntagged = opts.includeUntagged ?? !allowed;
  const excludeTags = new Set(opts.excludeTags ?? []);

  // 「〜だけ」の指定。明示的に選んだものが勝つので、場面の除外より先に効かせる
  const only = (opts.only ?? []).filter(Boolean).map((x) => x.toLowerCase());
  // families で選ばれた系統の集合。推測で系統が付いた曲（canonical は空）の判定に使う
  const allowedFamilies = opts.families?.length ? new Set(opts.families) : null;
  // 音の群れによる絞り込み。**全曲が必ずどれかの群に入っているので、ここで眠る曲は出ない。**
  // ジャンル選択(テキスト)とは別系統で、両方指定すれば AND になる。
  const allowedGroups = opts.groups?.length ? new Set(opts.groups) : null;
  const animeMode = opts.anime ?? 'exclude';
  const groupLabel = new Map(sound.groups.map((g) => [g.id, g.label ?? g.id]));
  // **つなぎ用の曲は通常の選出から必ず外す。** 場面の設定やジャンル選択より先に効かせる。
  // 単体ではかけられない曲（途中で BPM が 100 → 220 に変わる）なので、
  // --only で名前を打っても普通の曲としては出さない。✂ への挿し込みにだけ使う。
  // （2026-10-17: この網が無かったため、60 分のセットに 1 曲混ざっていた）
  const transitions = tracks.filter((t) => t.transition != null);
  const normal = tracks.filter((t) => t.transition == null);

  const filtered = normal.filter((t) => {
    if (only.length) {
      const hay = `${t.artist} ${t.title} ${t.basename} ${t.path ?? ''}`.toLowerCase();
      if (!only.some((q) => hay.includes(q))) { dropped.push({ basename: t.basename, reason: `「${only.join(' / ')}」を含まない` }); return false; }
      return true;   // 明示指定が勝つ。場面の除外は適用しない
    }
    // アニソンの軸。音の群れの選択とは独立に効く
    if (animeMode === 'exclude' && t.isAnime) {
      dropped.push({ basename: t.basename, reason: 'アニソン（入れない設定）' }); return false;
    }
    if (animeMode === 'only' && !t.isAnime) {
      dropped.push({ basename: t.basename, reason: 'アニソンではない（アニソンだけの設定）' }); return false;
    }
    if (allowedGroups && !allowedGroups.has(t.soundGroup)) {
      dropped.push({ basename: t.basename, reason: `選んでいない音の群れ (${groupLabel.get(t.soundGroup) ?? t.soundGroup})` });
      return false;
    }
    if (!t.canonical) {
      // 推測で系統が付いていて、その系統が選ばれているなら通す（ジャンル選択の恩恵を受けられる）
      const guessedOk = allowedFamilies && t.family && allowedFamilies.has(t.family);
      if (!guessedOk && !includeUntagged) {
        dropped.push({ basename: t.basename, reason: t.family ? `推測した系統が対象外 (~${t.family})` : 'ジャンル欄が空（含めない設定）' });
        return false;
      }
    } else {
      if (excludeGenres.has(t.canonical)) { dropped.push({ basename: t.basename, reason: `この場面では使わないジャンル (${t.canonical})` }); return false; }
      if (allowed && !allowed.has(t.canonical)) { dropped.push({ basename: t.basename, reason: `選んでいないジャンル (${t.canonical})` }); return false; }
    }
    // ドロップの落差。**起伏を持たない曲は素通しする**（null = 知らない、であって「静か」ではない）
    if (opts.maxDropDb != null && t.dropDb != null && t.dropDb > opts.maxDropDb) {
      dropped.push({ basename: t.basename, reason: `ドロップの落差が大きい (${t.dropDb.toFixed(1)}dB > ${opts.maxDropDb}dB)` });
      return false;
    }
    const hit = t.contextTags.filter((g) => excludeTags.has(g));
    if (hit.length) { dropped.push({ basename: t.basename, reason: `この場面ではかけられない (${hit.join(', ')})` }); return false; }
    return true;
  });

  return {
    tracks: filtered, transitions, dropped, analyzerVersion: versions.join(','), missingColumns: missing,
    soundGroupLabels: sound.groups.map((g) => ({ id: g.id, label: g.label ?? g.id })),
  };
}

/** 音色距離。timbre は L2 正規化済みなので内積 = cosine 類似度 */
export function timbreDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return 1 - Math.max(-1, Math.min(1, dot));   // 0 = そっくり, 2 = 正反対
}
