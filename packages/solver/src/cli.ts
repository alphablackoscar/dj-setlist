// CLI。音源にもネットワークにも触らない。
//
//   node packages/solver/src/cli.ts --request requests/example.json
//   node packages/solver/src/cli.ts --anchor "Stand High" --n 13 --curve horizontal_to_vertical
//   node packages/solver/src/cli.ts --list            プールの中身を見る
//
// 既定のパスはリポジトリのルートから見た相対。どこから叩いてもよいように解決する。

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPool } from './pool.ts';
import { solve, solveMany, searchTracks, type SolveResult } from './beam.ts';
import { formatTable, rekordboxXml, m3u, setMinutes, type SetTiming } from './export.ts';
import { planBridges, bridgeLabel } from './bridge.ts';
import { cardOf, planBlocks, resolveBlocks, buildLayout, bpmForCard, substituteCards, type Card, type Block, type Layout } from './blocks.ts';
import { placeWishes, type WishResult } from './wish.ts';
import type { SolveRequest } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// --json: **標準出力を JSON 専用にする。** Electron の画面から子プロセスとして呼ぶため。
// 人が読む出力（進捗・表・注意書き）は標準エラーに回す。console.log を差し替えるだけで
// 全部まとめて移せるので、呼び出し箇所を 1 つずつ書き換えなくてよい。
const jsonMode = !!args.json;
if (jsonMode) console.log = console.error.bind(console);

const dbPath = String(args.db ?? join(ROOT, 'data/features.db'));
const xmlPath = String(args.xml ?? join(ROOT, 'data/collection.xml'));
const configDir = String(args.config ?? join(ROOT, 'config'));
const outDir = String(args.out ?? join(ROOT, 'out'));

if (!existsSync(dbPath)) { console.error(`features.db がありません: ${dbPath}`); process.exit(1); }

// --- request の組み立て。ファイル指定が基本、フラグはその上書き ---
let req: SolveRequest = {};
if (args.request) req = JSON.parse(readFileSync(String(args.request), 'utf8'));
if (args.anchor) req.anchor = { title: String(args.anchor) };
// --wish "a.mp3|b.mp3"   使いたい曲のファイル名。区切りは | （Windows のファイル名に使えない文字）
if (args.wish) req.wish = String(args.wish).split('|').map((x) => x.trim()).filter(Boolean);
if (args.n != null) {
  const nn = Number(args.n);
  if (!Number.isInteger(nn) || nn < 1) {
    console.error(`曲数は 1 以上の整数で指定してください（受け取った値: ${String(args.n)}）`);
    process.exit(1);
  }
  req.n = nn;
}
if (args.curve) req.curve = String(args.curve);
if (args['end-bpm']) req.end_bpm = Number(args['end-bpm']);
if (args.band) { const [lo, hi] = String(args.band).split(/[-,~]/).map(Number); req.bpm_band = [lo, hi]; }
if (args.start) req.anchor_position = 'start';
if (args.families) req.families = String(args.families).split(',');
if (args.groups) req.groups = String(args.groups).split(',');
if (args.anime) req.anime = String(args.anime) as any;
if (args.seed) req.seed = Number(args.seed) === 0 ? 0 : (Number(args.seed) || Math.floor(Math.random() * 1e9));
// おまかせ = 毎回違う種。--seed に数字を渡せば同じ結果を再現できる
if (args.shuffle && req.seed == null) req.seed = Math.floor(Math.random() * 1e9);
// --set-bpm 129           セット全体を 129 で回す
// --set-bpm 126:1,129:7   1 曲目から 126、7 曲目から 129
if (args['set-bpm']) {
  const raw = String(args['set-bpm']).trim();
  if (raw === 'off' || raw === 'none') req.set_bpm = null;
  else if (raw === 'auto') req.set_bpm = 'auto' as any;
  else if (raw.includes(',') || raw.includes(':')) {
    req.set_bpm = raw.split(',').map((part) => {
      const [b, from] = part.split(':');
      return { from: Number(from ?? 1), bpm: Number(b) };
    }).filter((x) => x.bpm > 0);
  } else req.set_bpm = Number(raw);
}
if (args.genres) req.genres = String(args.genres).split(',');
if (args.only) req.only = String(args.only).split(',');
if (args.venue) req.venue = String(args.venue);
// **持ち時間は黙って既定に化けさせない。**
// 以前は画面側が `Number(値) || 30` としていたため、0 や空や打ち間違いが
// 黙って 30 分になっていた（2026-10-03）。ここで断って理由を言う。
// 上限・下限は config/venues.json の set.min_minutes / max_minutes。
if (args.minutes != null) {
  const m = Number(args.minutes);
  if (!Number.isFinite(m)) {
    console.error(`持ち時間は数字で指定してください（受け取った値: "${String(args.minutes)}"）`);
    process.exit(1);
  }
  if (!Number.isInteger(m) || m <= 0) {
    console.error(`持ち時間は 1 分以上の整数で指定してください（受け取った値: ${m}）`);
    process.exit(1);
  }
  req.minutes = m;
}
if (args['start-genre']) { req.start_genre = String(args['start-genre']); req.anchor_position = 'start'; }
if (args['with-untagged']) req.include_untagged = true;
// 浅い時間向け。ドロップの落差が大きい曲を外す（--max-drop で数字を直接指定も可）
if (args.calm) req.calm = true;
if (args['no-untagged']) req.include_untagged = false;
if (args.context) req.context = String(args.context);
// --long   長いセット（1-2 時間）。ジャンル札の塊（3-4 曲）を並べて組む（blocks.ts）
// --cards hiphop,latin,pop,house,edm   今日使ってよい札（config/cards.json）。無ければ default_on の札
if (args.long) req.long = true;
if (args.cards) req.cards = String(args.cards).split(',').map((x) => x.trim()).filter(Boolean);

// --- 1 曲だけ差し替える: 前の結果 JSON を読み、その曲を除外して残りを固定して解き直す ---
let swapInfo: { position: number; removed: string; drop: boolean; kept: number } | null = null;
/**
 * 曲を 1 曲足す操作。**前の結果を土台にして 1 曲ぶん長いセットを解き直す。**
 *   --insert <位置>  その位置の「前」に 1 曲入れる（以降は 1 つずつ後ろへずれる）
 *   --append         いちばん後ろに 1 曲足す（持ち時間が増えたとき）
 * 入れる 1 枠以外は全部 fixed なので、**選ばれるのはセトリに無い曲だけ**
 * （beam の used / titleKey / 音色の重複判定がそのまま効く）。
 * キーも BPM も箱も時間帯も、土台にした request をそのまま引き継ぐ。
 */
let addInfo: { kind: 'insert' | 'append'; position: number; before: number; after: number } | null = null;
/** 曲を 1 つ足すときの位置。長いセットでは塊をこのぶん伸ばす必要がある */
let addAt: number | null = null;
/**
 * `--put <位置>:<basename>` の結果。**履歴から前の曲に戻す**操作（2026-10-21 ユーザー要求:
 * 「さっきの曲のほうが良かったな」）。指定の曲をその位置に固定し、他は全部そのまま。
 */
let putInfo: { position: number; basename: string; removed: string; restored: string } | null = null;
const dropMode = args.drop != null;
// **塊単位の作り直し（長いセット）。** 全部やり直しにせず、触らない塊の曲はそのまま残す。
//   --redo-block 2,5 | all     その塊の曲だけ選び直す（札と BPM はそのまま）
//   --set-block 3:latin        3 番目の塊の札を替えて、その塊だけ組み直す
//   --remove-cards anime       その札をやめる。その札の塊だけ前後に合う別の札に置き換え、他は残す
//   --keep-blocks 1,2          鍵。all / --remove-cards でもこの塊は触らない
// ユーザー指示（2026-10-16）:「セトリをうまく保持しながらランダムで選び直せること。最初から全部やり直しではきつい」
let blockOp: {
  prevCand: any; prevBlocks: any[];
  redo: Set<number>; setBlock: { i: number; card: string } | null; removeCards: Set<string>; keep: Set<number>;
} | null = null;
const listArg = (k: string) => args[k] != null ? String(args[k]).split(',').map((x) => x.trim()).filter(Boolean) : null;
const redoArg = listArg('redo-block'), setArg = args['set-block'] ? String(args['set-block']) : null, removeArg = listArg('remove-cards');
if (args.from && (redoArg || setArg || removeArg)) {
  const prev = JSON.parse(readFileSync(String(args.from), 'utf8'));
  const cand = prev.candidates?.[Number(args.candidate ?? 1) - 1];
  if (!cand) { console.error(`${args.from} に候補がありません`); process.exit(1); }
  const prevBlocks: any[] = prev.blocks ?? [];
  if (!prevBlocks.length || !prev.request?.plan) { console.error('この結果は塊に分かれていません。塊の操作は長いセット（--long）でだけ使えます'); process.exit(1); }
  req = { ...prev.request, ...req };
  const keep = new Set((listArg('keep-blocks') ?? []).map((x) => Number(x) - 1));
  const redo = new Set<number>();
  if (redoArg) {
    if (redoArg.includes('all')) prevBlocks.forEach((b: any) => { if (!keep.has(b.index)) redo.add(b.index); });
    else for (const x of redoArg) {
      const k = Number(x) - 1;
      if (!prevBlocks[k]) { console.error(`${x} 番目の塊はありません（全 ${prevBlocks.length} 塊）`); process.exit(1); }
      redo.add(k);
    }
  }
  let setBlock: { i: number; card: string } | null = null;
  if (setArg) {
    const [x, card] = setArg.split(':');
    const k = Number(x) - 1;
    if (!prevBlocks[k] || !card) { console.error(`--set-block は「番号:札」で指定してください（例 3:latin）`); process.exit(1); }
    setBlock = { i: k, card };
  }
  // 選び直しは毎回違う結果が欲しいので、種を指定していなければ乱数にする
  if (!args.seed) req.seed = Math.floor(Math.random() * 1e9);
  blockOp = { prevCand: cand, prevBlocks, redo, setBlock, removeCards: new Set(removeArg ?? []), keep };
} else if (args.from) {
  const prev = JSON.parse(readFileSync(String(args.from), 'utf8'));
  const cand = prev.candidates?.[Number(args.candidate ?? 1) - 1];
  if (!cand) { console.error(`${args.from} に候補がありません`); process.exit(1); }
  const insertAt = args.insert != null ? Number(args.insert) : null;
  const appendMode = !!args.append;

  // --- 曲を足す（--insert / --append）。曲数が 1 増える唯一の経路 ---
  if (insertAt != null || appendMode) {
    const prevN = cand.entries.length;
    const at = appendMode ? prevN + 1 : insertAt as number;
    if (!(at >= 1 && at <= prevN + 1)) {
      console.error(`${at} 曲目には入れられません（1〜${prevN + 1} の範囲で指定してください）`);
      process.exit(1);
    }
    req = { ...prev.request, ...req };
    req.n = prevN + 1;
    // 入れる枠より前はそのまま、後ろは 1 つずつ下へずらして固定する
    const fixed: Record<string, string> = {};
    for (const e of cand.entries) {
      const np = e.position < at ? e.position : e.position + 1;
      fixed[String(np)] = e.basename;
    }
    req.fixed = fixed;
    addInfo = {
      kind: appendMode ? 'append' : 'insert',
      position: at,
      before: prevN,
      after: prevN + 1,
    };
    addAt = at;
  } else if (args.put != null) {
    // --- `--put <位置>:<basename>` 前の曲に戻す（画面の「履歴」から呼ばれる）---
    //
    // **その位置にその曲を固定し、他は 1 曲も動かさない。** 差し替えが「違う曲を選ばせる」
    // 操作なのに対して、こちらは**曲を名指しする**（履歴に残っているのは実際に入っていた曲）。
    // basename を使う理由は他と同じ: 曲名の文字列で引くと別の曲を掴む。
    const raw = String(args.put);
    const sep = raw.indexOf(':');            // Windows の basename に ':' は入らないので最初の 1 つで切る
    const pos = Number(raw.slice(0, sep));
    const bn = raw.slice(sep + 1);
    if (!(sep > 0) || !Number.isInteger(pos) || pos < 1 || !bn) {
      console.error('--put は <位置>:<ファイル名> の形で指定してください（例: --put "3:Legend.mp3"）');
      process.exit(1);
    }
    const target = cand.entries.find((e: any) => e.position === pos);
    if (!target) { console.error(`${pos} 曲目がありません`); process.exit(1); }
    // **既にセトリに居る曲は戻せない**（固定が二重になって同じ曲が 2 回出る）。
    // 黙って重複を作らず、理由を言って止める
    const dup = cand.entries.find((e: any) => e.basename === bn && e.position !== pos);
    if (dup) {
      console.error(`「${dup.title}」は既に ${dup.position} 曲目に入っています（同じ曲は 1 セットに 1 回だけ）`);
      process.exit(1);
    }
    req = { ...prev.request, ...req };
    req.n = cand.entries.length;
    const fixed = Object.fromEntries(cand.entries.map((e: any) => [String(e.position), e.basename]));
    fixed[String(pos)] = bn;
    req.fixed = fixed;
    // **exclude から外す。** 差し替えのたびに `request.exclude` へ積まれており（上の --swap）、
    // そのまま解くと**戻したい曲がプールから消えていて組めない**（pool.ts が読み込み時に捨てる）。
    req.exclude = (req.exclude ?? []).filter((x: string) => x !== bn);
    putInfo = { position: pos, basename: bn, removed: `${target.title} / ${target.artist}`, restored: bn };
  } else {
  const pos = Number(args.drop ?? args.swap ?? 0);
  if (!pos) { console.error('--from を使うときは --drop <位置>（そこから後ろを作り直す）/ --swap <位置>（その 1 曲だけ替える）/ --insert <位置>（その前に 1 曲入れる）/ --append（後ろに 1 曲足す）のどれかを指定してください'); process.exit(1); }
  const target = cand.entries.find((e: any) => e.position === pos);
  if (!target) { console.error(`${pos} 曲目がありません`); process.exit(1); }
  req = { ...prev.request, ...req };
  req.n = cand.entries.length;
  // --swap: その 1 曲だけ替える（他は全部固定）
  // --drop: そこから後ろを作り直す（前だけ固定）。DJ が頭から固めていく流れ
  const keep = dropMode
    ? cand.entries.filter((e: any) => e.position < pos)
    : cand.entries.filter((e: any) => e.position !== pos);
  req.fixed = Object.fromEntries(keep.map((e: any) => [String(e.position), e.basename]));
  req.exclude = [...(req.exclude ?? []), target.basename];
  swapInfo = { position: pos, removed: `${target.title} / ${target.artist}`, drop: dropMode, kept: keep.length };
  }
}

const weights = JSON.parse(readFileSync(join(configDir, 'weights.json'), 'utf8'));
const curves = JSON.parse(readFileSync(join(configDir, 'curves.json'), 'utf8'));
const contexts = JSON.parse(readFileSync(join(configDir, 'contexts.json'), 'utf8'));
const venuesCfg = JSON.parse(readFileSync(join(configDir, 'venues.json'), 'utf8'));

const cardsCfg = JSON.parse(readFileSync(join(configDir, 'cards.json'), 'utf8'));
const longSet = !!req.long;
if (longSet) {
  // 長いセットは 1 つの箱の指定を使わない（塊ごとに札と BPM が決まる）
  req.venue = undefined; req.bpm_band = undefined; req.groups = null;
}

// --- 箱: BPM 帯と色の既定を入れる。個別指定があればそちらが勝つ ---
let venue: any = null;
if (req.venue) {
  venue = venuesCfg.venues[req.venue];
  if (!venue) {
    console.error(`未知の箱: ${req.venue}（config/venues.json にあるのは ${Object.keys(venuesCfg.venues).join(', ')}）`);
    process.exit(1);
  }
  if (!req.bpm_band && venue.bpm_band) req.bpm_band = venue.bpm_band;
  if (!req.curve && venue.curve) req.curve = venue.curve;
  if (!req.context && venue.context) req.context = venue.context;
  // **セットの BPM は箱ごとに既定を持つ。** --set-bpm off で従来方式に戻せる
  if (req.set_bpm === undefined && venue.default_set_bpm) req.set_bpm = venue.default_set_bpm;
}

// --- 持ち時間 -> 曲数。曲の長さからは出せない（実測 4.0 分/曲だが 30 分で 13 曲） ---
// **持ち時間の上下限。** 桁を間違えた入力でソルバーを何分も走らせない
// `max_minutes` は**既定の上限**で、画面の ⚙ 設定 から変えられる（6 時間回す人もいる）。
// 上限を超えたときは「駄目」で終わらせず、**どこを変えれば通るか**を必ず言う。
const MIN_MINUTES = Number(venuesCfg.set?.min_minutes ?? 1);
const MAX_MINUTES = Number(venuesCfg.set?.max_minutes ?? 120);
if (req.minutes != null && req.minutes < MIN_MINUTES) {
  console.error(`持ち時間は ${MIN_MINUTES} 分以上で指定してください（受け取った値: ${req.minutes} 分）`);
  process.exit(1);
}
if (req.minutes != null && req.minutes > MAX_MINUTES) {
  console.error(`持ち時間の上限は ${MAX_MINUTES} 分です（受け取った値: ${req.minutes} 分）。`
    + ` もっと長く回すなら ⚙ 設定 で「持ち時間の上限」を上げてください`);
  process.exit(1);
}

// **--from のときは再計算しない。** 土台にした結果の曲数（+1）が正しいので、
// 持ち時間から引き直すと --insert / --append の 1 曲増が打ち消される（2026-10-03）
const MINUTES_PER_TRACK = Number(venuesCfg.set?.minutes_per_track ?? 2.31);
if (req.minutes && !args.n && !args.from) {
  req.n = Math.max(2, Math.round(req.minutes / MINUTES_PER_TRACK));
}

// どこでかけるセットか。BPM もキーも合っていても、その場でかけられない曲はここで落とす
const ctxName = req.context ?? contexts.default;
const ctx = contexts.contexts[ctxName];
if (!ctx) {
  console.error(`未知の context: ${ctxName}（config/contexts.json にあるのは ${Object.keys(contexts.contexts).join(', ')}）`);
  process.exit(1);
}

// 「〜だけ」を明示したときは、場面の除外・位置制約より指定が勝つ。
// 例: ラブライブ縛りのセットに「anime は 5 曲目以降」を課しても組めない
const onlyMode = !!req.only?.length;

// アニソンは音では分離できないので別軸で扱う。既定は場面から決まる（nightclub なら入れない）
const baseAnime: 'exclude' | 'include' | 'only' =
  req.anime ?? (onlyMode ? 'include' : ((ctx.exclude_tags ?? []).includes('anime') ? 'exclude' : 'include'));

// --- 長いセット: 今日使ってよい札。**アニソンを使えるかは札のチェックで決まる** ---
// 指定が無ければ default_on の札。アニソンの札は場面（nightclub は外す）と --anime に従う
const animeCardId: string | undefined = cardsCfg.cards.find((c: any) => c.anime)?.id;
let palette: string[] = [];
if (longSet) {
  palette = req.cards ?? cardsCfg.cards
    .filter((c: any) => c.anime ? baseAnime !== 'exclude' : c.default_on).map((c: any) => c.id);
  const unknown = palette.filter((id) => !cardsCfg.cards.some((c: any) => c.id === id));
  if (unknown.length) {
    console.error(`未知の札: ${unknown.join(', ')}（config/cards.json にあるのは ${cardsCfg.cards.map((c: any) => c.id).join(', ')}）`);
    process.exit(1);
  }
  if (blockOp) palette = palette.filter((c) => !blockOp!.removeCards.has(c));
  req.cards = palette;
}
// 鍵をかけたアニソンの塊は、札を外しても残すのでプールに要る
const keptAnime = !!blockOp && (req.plan ?? []).some((b, i) => b.card === animeCardId && blockOp!.keep.has(i));
const animeMode: 'exclude' | 'include' | 'only' = !longSet ? baseAnime
  : (animeCardId && (palette.includes(animeCardId) || keptAnime)) ? 'include' : 'exclude';

// **アニソンを入れる/だけ にしたら、場面側のアニソン除外は打ち消す。**
// そうしないと「アニソンだけ」を選んだのに場面が先に全部落として 0 曲になる（実際になった）。
// 明示的な指定が場面の既定より強い、という他の絞り込みと同じ考え方。
const animeOn = animeMode !== 'exclude';
const ctxExcludeGenres = onlyMode ? [] : (ctx.exclude_genres ?? []).filter((g: string) => !(animeOn && g === 'soundtrack'));
const ctxExcludeTags = onlyMode ? [] : (ctx.exclude_tags ?? []).filter((t: string) => !(animeOn && t === 'anime'));

// --- 浅い時間向け: ドロップの落差が大きい曲を外す ---
//
// 講師の指摘:「ポップスでもビルドアップが強い曲は浅い時間に不向き。
// うるさすぎてカフェ利用の客が話せない」。**講師によって線引きが割れる論点**なので、
// 既定では効かせず、しきい値も config/venues.json 側から動かせるようにしてある。
//   --calm            venues.json の calm.max_drop_db を使う（既定 12dB）
//   --max-drop <dB>   数字で直接指定する
const maxDropDb: number | null =
  args['max-drop'] != null ? Number(args['max-drop'])
    : req.calm ? Number(venuesCfg.calm?.max_drop_db ?? 12)
      : null;

const pool = buildPool({
  dbPath, xmlPath: existsSync(xmlPath) ? xmlPath : undefined, configDir,
  genres: req.genres ?? null, families: req.families ?? null, groups: req.groups ?? null, only: req.only ?? null,
  anime: animeMode,
  includeUntagged: req.include_untagged,
  excludeGenres: ctxExcludeGenres,
  exclude: req.exclude ?? [],
  excludeTags: ctxExcludeTags,
  maxDropDb,
});

if (onlyMode) {
  console.log(`「${req.only!.join(' / ')}」を含む曲だけで組みます`);
  console.log(`  ※ 明示的に選んでいるので、場面（${ctx.label}）の除外と位置制約は適用しません`);
} else {
  const groupLabel = new Map(pool.soundGroupLabels.map((g) => [g.id, g.label]));
  const picked = [
    ...(req.groups ?? []).map((g) => groupLabel.get(g) ?? g),
    ...(req.families ?? []), ...(req.genres ?? []),
  ];
  const selection = picked.length
    ? `選んだもの: ${picked.join(', ')}`
    : '選んだもの: なし（この場面で使えるもの全部）';
  console.log(`場面: ${ctx.label}`);
  console.log(selection +
    (ctxExcludeGenres.length ? `  / ${ctxExcludeGenres.join(', ')} は場面として除外` : '') +
    (ctxExcludeTags.length ? `  / ${ctxExcludeTags.join(', ')} を除外` : ''));
}
console.log(`プール: ${pool.tracks.length} 曲 (analyzer ${pool.analyzerVersion})` +
  (pool.dropped.length ? `  / 除外 ${pool.dropped.length} 曲` : ''));
if (pool.dropped.length && args.verbose) {
  const byReason = new Map<string, number>();
  for (const d of pool.dropped) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
  for (const [r, n] of byReason) console.log(`    ${n} 曲: ${r}`);
}
if (!existsSync(xmlPath)) console.log(`  ※ collection.xml が無いためパスが分かりません。M3U は出せますが再生できません`);
{
  // エネルギーの材料が DB に無い場合の警告。古い analyzer の DB を開いたときに黙って軸が死ぬのを防ぐ
  const need = Object.keys(weights.energy_features).filter((k) => !k.startsWith('_'));
  const lost = pool.missingColumns.filter((c) => need.includes(c));
  if (lost.length) console.log(`  ※ この DB には ${lost.join(', ')} がありません（analyzer が古い）。エネルギーの計算からその分が抜けます`);
}

// --- --find <語>: 曲を探す。**画面の「締めに置きたい曲」の候補一覧に使う。** ---
//
// 2026-08-08 に追加。それまでは --anchor に打った文字列で 1 曲を黙って決めており、
// 「girl friend」で Ariana Grande の曲（BPM 85）を掴んで、指定した箱の帯に届かず
// 「組めません」になっていた（実害）。**候補を見せて人に選ばせる**のが直し方。
if (args.find) {
  const hits = searchTracks(pool.tracks, String(args.find), 30);
  // その曲がこのセットの BPM に寄せられるか、寄せるなら何%かを添える。
  // 「見つかったが使えない」を作る前に分からせるのが目的
  const tol = Number(weights.set_bpm?.pitch_tolerance ?? 0.05);
  // **おまかせ（auto）のときは目標を決めない。** 締めに選んだ曲に BPM を合わせるので、
  // 「箱の帯に入っていれば使える」で判定するのが正しい（暫定の BPM に対するピッチを
  // 出すと、実際に組んだときの値と食い違う）
  const targets: number[] = longSet ? [] : typeof req.set_bpm === 'number' ? [req.set_bpm]
    : Array.isArray(req.set_bpm) ? req.set_bpm.map((x: any) => Number(x.bpm)) : [];
  const autoMode = (req.set_bpm as any) === 'auto' || longSet;
  const mults: number[] = weights.hard.bpm_multipliers ?? [0.5, 1, 2];
  const rows = hits.map((t) => {
    let best: { target: number; mult: number; pitch: number } | null = null;
    for (const target of targets) for (const m of mults) {
      const p = (target - t.bpm * m) / (t.bpm * m);
      if (Math.abs(p) <= tol && (!best || Math.abs(p) < Math.abs(best.pitch))) best = { target, mult: m, pitch: p };
    }
    // 長いセットなら締めの曲は最後の章の帯で判定する
    const fb: [number, number] | undefined = longSet ? undefined : req.bpm_band;
    const inBand = !fb || mults.some((m) => t.bpm * m >= fb[0] && t.bpm * m <= fb[1]);
    return {
      title: t.title, artist: t.artist, basename: t.basename, bpm: t.bpm, camelot: t.camelot,
      soundGroup: t.soundGroup, isAnime: t.isAnime,
      // **試聴に要る 3 つ**（2026-10-21 追加）。無かったため探した曲を聴けず、
      // ユーザーがどのリミックスを選んでいるのか耳で確かめられなかった。
      // `path` が無いと main.js の allowedAudio にも入らない（= 鳴らす許可が出ない）
      path: t.path, windowStart: t.windowStart, duration: t.duration,
      usable: targets.length ? !!best : inBand,
      autoBpm: autoMode ? Math.round(t.bpm) : null,   // おまかせならセットはこの BPM になる
      pitch: best?.pitch ?? null, setBpm: best?.target ?? null, multiplier: best?.mult ?? null,
    };
  });
  // **書き終わってから終える。** Mac / Linux のパイプは非同期なので、write の直後に exit すると
  // 8KB 前後で JSON が切れる（2026-10-21 Mac で実測: 候補に path を足したら画面の検索が必ず失敗した。
  // Windows のパイプは同期書き込みなので起きない）
  if (jsonMode) {
    await new Promise((done) => process.stdout.write(JSON.stringify({ query: String(args.find), results: rows }), () => done(null)));
    process.exit(0);
  }
  console.log(`\n「${args.find}」の候補（上から一致度順）:\n`);
  for (const r of rows) {
    const mark = r.usable ? '✓' : '×';
    const p = r.pitch != null ? `${r.pitch > 0 ? '+' : ''}${(r.pitch * 100).toFixed(1)}%` : '';
    console.log(`  ${mark} ${r.bpm.toFixed(1).padStart(6)} ${(r.camelot ?? '??').padEnd(4)} ${p.padStart(7)}  ${r.title.slice(0, 46)} — ${r.artist.slice(0, 26)}`);
  }
  console.log('\n  ✓ = このオーダーで締めに使える / × = BPM が届かない');
  console.log('  使うとき: --anchor "曲名の一部"');
  process.exit(0);
}

// --- セットの BPM を「おまかせ」で決める ---
//
// ユーザー指摘（2026-08-08）:「BPM を支配的に指定してやるケースは少ないのでは？
// 最後の曲を指定すれば一意に決まるし、pops おまかせなら 128 でも 126 でも大差ない」
//
// そのとおりなので **既定はおまかせ**にした。決め方は 2 つだけ:
//   1. 締めの曲が決まっているなら **その曲の原曲 BPM**（締めをピッチ 0 でかけられる）
//   2. 決まっていないなら **候補プールの BPM の中央値**（全体のピッチ量が最小になる）
// どちらも箱の BPM 帯には収める。
let autoBpmNote: string | null = null;
let layout: Layout | null = null;
let blockNotes: string[] = [];
/** 塊の操作で組み直す塊（0 始まり）。表示用 */
let refill: Set<number> | null = null;
/** 曲 -> 札。外（検査・画面）から参照できるよう外に出してある。長いセット以外では空 */
const cardOfTrack = new Map<string, string>();
/**
 * 繋いだと見なす BPM 差の上限（cards.json の plan.mix_max）。これを超えたら ✂。
 * **塊の並びを決めるときと、✂ につなぎを挿し込むときの両方で使う**ので外に出してある
 * （2 箇所で別の数字を使うと「繋がる」の意味が割れる）。
 */
const mixMax = Number(cardsCfg.plan?.mix_max ?? 0.05);
if (longSet) {
  const cards: Card[] = cardsCfg.cards;
  const cardMap = cardOfTrack;
  for (const t of pool.tracks) { const c = cardOf(t, cards); if (c) cardMap.set(t.key, c); }
  const curveName = req.curve ?? curves.default;
  const curve = curves.curves[curveName];
  const planCfg = cardsCfg.plan;
  let plan: Block[] = [];
  if (args.from && req.plan?.length) {
    // **塊の並びは前の結果を引き継ぐ。** 触る塊だけ札・BPM を変え、その塊の曲だけ組み直す。
    // --drop / --swap（blockOp なし）でも並びは変えない（変えると固定した曲が収まらない）
    plan = req.plan.map((b) => ({ ...b }));
    // **曲を足すときは、その位置を含む塊を 1 曲ぶん伸ばす。**（2026-10-17 に見つけた不具合）
    // これをしないと、下の `req.n = layout.n` が引き継いだ塊の合計（= 元の曲数）で
    // 上書きしてしまい、**「27 曲にしました」と報告しながら 26 曲のまま**になる。
    // 塊は 3-4 曲が目安で、埋めるためなら 5 曲も許容しているので伸ばしてよい。
    if (addAt != null && plan.length) {
      let acc = 0, idx = plan.length - 1;
      for (let i = 0; i < plan.length; i++) { acc += plan[i].n; if (addAt <= acc) { idx = i; break; } }
      plan[idx] = { ...plan[idx], n: plan[idx].n + 1 };
    }
  }
  if (blockOp) {
    refill = new Set(blockOp.redo);
    if (blockOp.setBlock) {
      const { i, card } = blockOp.setBlock;
      if (!cards.some((c) => c.id === card)) { console.error(`未知の札: ${card}`); process.exit(1); }
      const bpm = bpmForCard(card, plan[i].bpm, plan[i].n, { pool: pool.tracks, cardMap, cfg: planCfg }, cards.find((c) => c.id === card));
      if (bpm == null) { console.error(`「${card}」の曲が足りず、${i + 1} 番目の塊に置けません`); process.exit(2); }
      const lv = (id: string) => cards.find((c) => c.id === id)?.level ?? 0;
      const pv = plan[i - 1], nx = plan[i + 1];
      if ((pv && lv(card) > lv(pv.card) + 1) || (nx && lv(nx.card) > lv(card) + 1)) {
        blockNotes.push(`${i + 1} 番目を「${card}」にすると、前後で盛り上がりが 2 段以上飛びます（指定どおりにしました）`);
      }
      if ((pv && pv.card === card) || (nx && nx.card === card)) {
        blockNotes.push(`${i + 1} 番目を「${card}」にすると、隣も同じ札なので 1 つの長い塊になります`);
      }
      plan[i] = { ...plan[i], card, bpm };
      refill.add(i);
    }
    if (blockOp.removeCards.size) {
      const sub = substituteCards(plan, blockOp.removeCards, cards, palette, { pool: pool.tracks, cardMap, cfg: planCfg }, blockOp.keep);
      plan = sub.blocks;
      for (const i of sub.changed) refill.add(i);
      blockNotes.push(...sub.notes);
      if (!sub.changed.length && !sub.notes.length) blockNotes.push(`外した札（${[...blockOp.removeCards].join(', ')}）の塊はありませんでした。変更なし`);
    }
  } else if (!(args.from && req.plan?.length)) {
    const anchorHit = req.anchor
      ? searchTracks(pool.tracks, [req.anchor.title, req.anchor.artist, req.anchor.basename].filter(Boolean).join(' '), 1)[0] ?? null
      : null;
    const minPos: Record<string, number> = {};
    for (const c of cards) if (c.tag && (ctx.position_min ?? {})[c.tag] != null && !onlyMode) minPos[c.id] = Number(ctx.position_min[c.tag]);
    const r = planBlocks({
      cards, palette, n: Number(req.n ?? 26), curve, cardMap, pool: pool.tracks, cfg: planCfg,
      seed: req.seed ?? null, minPos, anchor: anchorHit,
    });
    blockNotes = r.notes;
    if (!r.blocks.length) { console.error('\n' + r.notes.join('\n')); process.exit(2); }
    plan = r.blocks;
  }
  const resolved = resolveBlocks(plan, cards, mixMax);
  layout = buildLayout(resolved, curve, cardMap, planCfg.peak_energy ? { energy: planCfg.peak_energy } : null);
  req.plan = plan;
  req.n = layout.n;
  req.set_bpm = layout.phases;
  if (blockOp && refill) {
    // 組み直さない塊の曲は同じ位置に固定する（塊の曲数は変えないので位置はずれない）
    const fixed: Record<string, string> = {};
    for (const e of blockOp.prevCand.entries) {
      const b = layout.blockAt(e.position);
      if (!refill.has(b)) fixed[String(e.position)] = e.basename;
    }
    req.fixed = fixed;
  }
} else if ((req.set_bpm as any) === 'auto') {
  const band = req.bpm_band ?? null;
  const clamp = (v: number) => band ? Math.min(band[1], Math.max(band[0], v)) : v;
  let picked: number | null = null;
  if (req.anchor) {
    const q = [req.anchor.title, req.anchor.artist, req.anchor.basename].filter(Boolean).join(' ');
    const hit = searchTracks(pool.tracks, q, 1)[0];
    if (hit) {
      const raw = Math.round(hit.bpm);
      picked = clamp(raw);
      autoBpmNote = picked === raw
        ? `締めの「${hit.title}」に合わせて ${picked} BPM にしました（締めはピッチ 0 でかけられます）`
        : `締めの「${hit.title}」は ${hit.bpm.toFixed(1)} BPM ですが、箱の帯 ${band![0]}-${band![1]} に収めて ${picked} BPM にしました`;
    }
  }
  if (picked == null) {
    // 帯の中にある曲の BPM の中央値。**ここを選ぶと全体のピッチ量が最小になる**
    const inBand = pool.tracks.map((t) => t.bpm).filter((b) => !band || (b >= band[0] && b <= band[1])).sort((a, b) => a - b);
    picked = inBand.length ? Math.round(inBand[Math.floor(inBand.length / 2)]) : clamp(128);
    autoBpmNote = `候補 ${inBand.length} 曲の真ん中を取って ${picked} BPM にしました（寄せる量が一番小さくなります）`;
  }
  req.set_bpm = picked;
}

// --- --list-groups: 音の群れの一覧と曲数。**Electron の選択 UI に出す内容そのもの。** ---
//
// ジャンル一覧(--list-genres, 39 個)より、こちらを選択 UI の主役にする。
// 理由: 全曲が必ずどれかの群に入るので **ジャンル欄が空の曲が選択から漏れない**。
// ジャンルのテキストで選ぶと 1331 曲（全体の 34%）が眠る。
if (args['list-groups']) {
  const byGroup = new Map<string, number>();
  for (const t of pool.tracks) byGroup.set(t.soundGroup, (byGroup.get(t.soundGroup) ?? 0) + 1);
  console.log('\nこの場面で選べる「音の群れ」（曲数つき）:\n');
  for (const g of pool.soundGroupLabels) {
    const n = byGroup.get(g.id) ?? 0;
    if (!n) continue;
    // その群に実際に入っている曲の BPM 帯とジャンルの内訳も出す。名前だけでは中身が分からないため
    const m = pool.tracks.filter((t) => t.soundGroup === g.id);
    const bpms = m.map((t) => t.bpm).sort((a, b) => a - b);
    const gc = new Map<string, number>();
    for (const t of m) gc.set(t.canonical || '(ジャンル欄が空)', (gc.get(t.canonical || '(ジャンル欄が空)') ?? 0) + 1);
    const top = [...gc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(' / ');
    console.log(`  ${g.id}  ${String(n).padStart(5)} 曲  BPM ${bpms[Math.floor(bpms.length * 0.1)]?.toFixed(0)}-${bpms[Math.floor(bpms.length * 0.9)]?.toFixed(0)}  ${g.label}`);
    console.log(`        ${top}`);
  }
  console.log(`\n合計 ${pool.tracks.length} 曲`);
  console.log('選ぶ: --groups g1,g2      名前は config/sound_groups.json の label（書き換えてよい）');
  process.exit(0);
}

// --- --list-genres: ジャンルの一覧と曲数（テキストのジャンルで細かく選びたいとき） ---
if (args['list-genres']) {
  const familyCfg = JSON.parse(readFileSync(join(configDir, 'genre_family.json'), 'utf8'));
  const byGenre = new Map<string, number>();
  for (const t of pool.tracks) byGenre.set(t.canonical || '(ジャンル空欄)', (byGenre.get(t.canonical || '(ジャンル空欄)') ?? 0) + 1);
  console.log('\nこの場面で選べるジャンル（曲数つき）:');
  for (const [fam, list] of Object.entries(familyCfg.families as Record<string, string[]>)) {
    const rows = list.map((c) => [c, byGenre.get(c) ?? 0] as const).filter(([, n]) => n > 0);
    if (!rows.length) continue;
    console.log(`\n  [${fam}]  計 ${rows.reduce((a, [, n]) => a + n, 0)} 曲`);
    for (const [c, n] of rows.sort((a, b) => b[1] - a[1])) console.log('    ' + String(n).padStart(5) + '  ' + c);
  }
  const blank = byGenre.get('(ジャンル空欄)') ?? 0;
  if (blank) console.log(`\n  [ジャンル欄が空]  ${blank} 曲` +
    '\n    ジャンルを選ぶとこれらは既定で外れます。--with-untagged で含められます');
  console.log(`\n合計 ${pool.tracks.length} 曲`);
  console.log('選ぶ: --genres techno,tech-house,house   まとめて: --families four-on-floor,techno');
  console.log('※ ジャンル欄が空の曲を漏らしたくないなら --list-groups の方を使う');
  process.exit(0);
}

// --- --list: プールを眺めるだけ ---
if (args.list) {
  const sorted = [...pool.tracks].sort((a, b) => a.energy - b.energy);
  const gl = new Map(pool.soundGroupLabels.map((g) => [g.id, g.label]));
  console.log('\n  ' + 'BPM'.padStart(6) + '  key   ' + 'エネ'.padStart(5) + '  ' + '縦ノリ'.padStart(6) + '  ' + '音の群れ'.padEnd(22) + 'タイトル');
  for (const t of sorted) {
    console.log('  ' + t.bpm.toFixed(1).padStart(6) + '  ' + (t.camelot ?? '??').padEnd(6) +
      t.energy.toFixed(2).padStart(5) + '  ' + t.groove.toFixed(2).padStart(6) + '  ' +
      (gl.get(t.soundGroup) ?? t.soundGroup ?? '-').padEnd(22) + t.title.slice(0, 46) +
      (t.flags.length ? '  [' + t.flags.join(' ') + ']' : ''));
  }
  process.exit(0);
}

if (!pool.tracks.length) { console.error('プールが空です。features.db の status=done を確認してください'); process.exit(1); }

// **総再生時間の計算に使う値**（config/venues.json の set）。曲数の換算とは別物。
// 曲の実長から出すので、短い曲が並んだセットが 27 分で終わることが見える（2026-10-17）
// played_fraction が null なら**プールから自動で決める**（2.31 / プールの平均の長さ）。
// こうすると「平均どおりの長さの曲が並んだセット = 持ち時間の換算どおり」になり、
// 短い曲が並んだセットだけが短く出る。固定値を書けばそれが勝つ。
// （解く前に要る。下の fitMinutes が案ごとの実時間を測るため）
const poolMeanMin = pool.tracks.length
  ? pool.tracks.reduce((a, t) => a + t.duration, 0) / pool.tracks.length / 60 : 4.16;
const timing: SetTiming = {
  playedFraction: venuesCfg.set?.played_fraction != null
    ? Number(venuesCfg.set.played_fraction)
    : Math.min(1, MINUTES_PER_TRACK / poolMeanMin),
  bridgePlayedFraction: Number(venuesCfg.set?.bridge_played_fraction ?? 0.9),
};

// --- 持ち時間に届かせる（2026-10-21 ユーザー決定）-----------------------------------
//
// **曲数の基準は経験則 1 曲 2.31 分（30 分 = 13 曲）のまま。** 長い曲が混ざっていても
// DJ は 2.3 分ほどで次へ行くので、曲の実長から出した見積もりで**曲数を減らしてはいけない**
// （一度そう作ったら 120 分が 47 曲 = 経験則で 108 分になり、不足を自分で作っていた）。
// 見積もりを使うのは**足りないときに足す**ときだけ。2〜3 分の edit は 2.31 分も鳴らせないので、
// 短い曲が並ぶと実際に早く終わる（ユーザー報告 2026-10-17「30 分が 27 分で終わりそう」）。
//   - 見積もりが持ち時間に届くまで 1 曲ずつ足して解き直す。目的関数は触らない
//   - **超過は言わない。** ユーザー:「ちょっと長いくらいで良い。最後は自分で調節したり減らせる。
//     5 分足りないと、どこに何を足すかまた考える必要がある」
//   - --n / --from（差し替え・足す・戻す）は通さない。**人が足した曲を時間で消さない**
//   - 長いセットは塊の並びで曲数が決まるので、ここでは扱わない
const fitTime = req.minutes != null && !args.n && !args.from && !longSet;
const fitMinutes = (first: SolveResult, solveAt: (n: number) => SolveResult): SolveResult => {
  const lo = req.minutes!;
  const minsOf = (r: SolveResult) => r.candidates[0] ? setMinutes(r.candidates[0], timing).total : -Infinity;
  let r = first, best = first;
  for (let k = 0; k < 20; k++) {
    const c = r.candidates[0];
    if (!c) break;
    if (minsOf(r) > minsOf(best)) best = r;
    if (minsOf(r) >= lo) return r;
    // 足りないのに曲数ぶん組めていない = プールが尽きた。増やしても組めない
    if (c.entries.length < r.n) break;
    // 足りない分を 1 曲あたりの時間で割って足す。**切り捨てて**足しすぎない側に寄せ、残りは次の周で足す
    // （曲数と時間は比例しない。曲数が変わると選ばれる曲ごと変わる。ロービートの 120 分は 12 曲ほど要る）
    const per = minsOf(r) / c.entries.length;
    r = solveAt(r.n + Math.max(1, Math.floor((lo - minsOf(r)) / per)));
  }
  // 届かなかったら一番長いもの。下の timeShort が不足を言う
  return best;
};

// --- 解く ---
const solveOpts = {
  positionMin: onlyMode ? {} : (ctx.position_min ?? {}),
  tone: venue?.tone ?? null,
  fixed: req.fixed ? new Map(Object.entries(req.fixed).map(([k, v]) => [Number(k), String(v)])) : undefined,
  layout,
  // 選び直す塊では、前の結果の曲を強く避ける（同じ曲が戻ってこないように）
  avoid: blockOp ? new Set<string>(blockOp.prevCand.entries
    .filter((e: any) => !Object.values(req.fixed ?? {}).includes(e.basename))
    .map((e: any) => pool.tracks.find((t) => t.basename === e.basename)?.key)
    .filter(Boolean)) : undefined,
};
const t0 = Date.now();
// 1 曲差し替えのときは案を増やさない（残りを固定しているので別案は作れない）
// --swap は 1 案（残り全部を固定しているので別案は作れない）。--drop は後半の別案を出す
// 全部固定するので解は 1 つしか出ない。案を 3 つ出そうとしても同じものが並ぶだけ
const singleOnly = (swapInfo && !swapInfo.drop) || !!addInfo || !!putInfo;
const many = singleOnly
  ? { results: [solve(pool.tracks, req, weights, curves, solveOpts)], overlaps: [0] }
  : solveMany(pool.tracks, req, weights, curves, solveOpts, fitTime ? fitMinutes : undefined);
const ms = Date.now() - t0;
const result = many.results[0];

if (venue) console.log(`箱: ${venue.label}  BPM ${venue.bpm_band?.join('-')}  色: ${(venue.tone ?? []).join(' / ')}`);
{
  // セットの BPM とピッチの許容を明示する。**何 BPM で回すのかは一番大事な情報**
  const tol = Number(weights.set_bpm?.pitch_tolerance ?? 0.05) * 100;
  if (typeof req.set_bpm === 'number') {
    console.log(`セットの BPM: ${req.set_bpm}（全曲をここへ寄せる。原曲から ±${tol.toFixed(0)}% まで）`);
    if (autoBpmNote) console.log(`  おまかせ: ${autoBpmNote}`);
  } else if (Array.isArray(req.set_bpm)) {
    const ph = [...req.set_bpm].sort((a, b) => a.from - b.from).map((x) => `${x.from} 曲目から ${x.bpm}`).join(' / ');
    console.log(`セットの BPM: ${ph}（原曲から ±${tol.toFixed(0)}% まで）`);
  } else {
    console.log('セットの BPM: 決めない（隣どうしが近ければよい方式。原曲の速度のまま選ぶ）');
  }
  if (req.seed != null) console.log(`おまかせ: 種 ${req.seed}（同じ種を渡せば同じ結果を再現できます）`);
  if (req.anime === 'only') console.log('アニソンだけで組みます');
  else if (req.anime === 'include') console.log('アニソンも入れます');
}
if (req.minutes && fitTime) {
  console.log(`持ち時間 ${req.minutes} 分 → ${req.n} 曲（1 曲あたり ${MINUTES_PER_TRACK} 分で換算）` +
    (many.results.some((r) => r.n > Number(req.n)) ? `。短い曲が多く届かない案は足しました（${many.results.map((r) => r.n).join(' / ')} 曲）` : ''));
} else if (req.minutes) console.log(`持ち時間 ${req.minutes} 分 → ${req.n} 曲（1 曲あたり ${venuesCfg.set?.minutes_per_track} 分で換算）`);
if (layout) {
  const lbl = (id: string) => cardsCfg.cards.find((c: any) => c.id === id)?.label ?? id;
  console.log(`使う札: ${palette.map(lbl).join(' / ')}`);
  console.log('塊の並び（✂ = カットで BPM を切り替える）:');
  console.log('  ' + layout.blocks.map((b) => `${b.cut ? '✂ ' : ''}[${b.label} ${b.n}]`).join(' '));
  for (const b of layout.blocks) {
    const mark = refill ? (refill.has(b.index) ? '  （組み直す）' : '  （残す）') : '';
    console.log(`  ${String(b.index + 1).padStart(2)}. ${b.cut ? '✂' : ' '} ${b.label}  ${b.start}-${b.end} 曲目  ${b.bpm} BPM  段 ${b.level}${mark}`);
  }
  for (const n of blockNotes) console.log(`  ※ ${n}`);
}
if (putInfo) {
  console.log(`\n${putInfo.position} 曲目を前の曲に戻しました（「${putInfo.removed}」を外して「${putInfo.basename}」へ）`);
}
if (swapInfo) {
  console.log(swapInfo.drop
    ? `\n${swapInfo.position} 曲目「${swapInfo.removed}」を外しました。1〜${swapInfo.kept} 曲目はそのまま、${swapInfo.position} 曲目以降を組み直します`
    : `\n差し替え: ${swapInfo.position} 曲目「${swapInfo.removed}」を外して、残り ${swapInfo.kept} 曲は固定のまま埋め直します`);
}

const curveName = req.curve ?? curves.default;
console.log(`\n流れ: ${curves.curves[curveName].label}` +
  `  /  アンカー: ${result.anchor ? `${result.anchor.title}（${(req.anchor_position ?? 'end') === 'end' ? '終曲' : '1 曲目'}）` : '指定なし'}` +
  `  /  ${result.n} 曲  /  ${ms}ms`);
for (const n of result.notes) console.log(`  ※ ${n}`);

const candidates = many.results.map((r) => r.candidates[0]).filter(Boolean);
if (!candidates.length) {
  console.error('\nセットが組めませんでした。上の ※ が理由です。');
  console.error('  試すこと: --band を広げる / --n を減らす / ジャンルの絞り込みをゆるめる');
  process.exit(2);
}

// --- 使いたい曲を混ぜる（2026-10-20。wish.ts）---------------------------------------
//
// 組んだ案の 1 曲と入れ替える。入れ替える位置以外は全部固定して解き直すので、
// BPM・キー・アーティスト・塊の札・時間帯の制約は --swap と同じだけ効く。
// **--from（差し替え・足す・塊の操作）では入れ直さない。** 前の結果に入れた曲は固定で残るため。
let wishResults: WishResult[][] | null = null;
if (req.wish?.length && !args.from) {
  const tw = Date.now();
  const maxDelta = Number(weights.wish?.max_cost_increase ?? 1.0);
  const pitchTol = Number(weights.set_bpm?.pitch_tolerance ?? 0.05);
  const tol = req.set_bpm != null ? pitchTol : Number(weights.hard.bpm_tolerance);
  const mults: number[] = weights.hard.bpm_multipliers ?? [0.5, 1, 2];
  const found = req.wish.map((bn) => pool.tracks.find((t) => t.basename === bn) ?? bn);
  wishResults = candidates.map((c, ci) => {
    // 締めの位置は案ごとの曲数で決まる（持ち時間に合わせて案ごとに曲数が違うことがある）
    const n = c.entries.length;
    const locked = new Set<number>();
    if (result.anchor) locked.add((req.anchor_position ?? 'end') === 'end' ? n : 1);
    const tracks = found.filter((x): x is typeof pool.tracks[number] => typeof x !== 'string');
    const { cand, results } = placeWishes(c, tracks, {
      locked, maxDelta,
      prefilter: (t, p) => {
        if (layout && !layout.allowAt(p, t)) {
          const card = cardOfTrack.get(t.key);
          const label = cardsCfg.cards.find((x: any) => x.id === card)?.label;
          if (!card) return { stage: 1, reason: 'どのジャンルの札にも入らない曲なので、長いセットでは使えない' };
          if (!layout.blocks.some((b) => b.card === card)) return { stage: 1, reason: `このセットに「${label}」の塊が無い` };
          return { stage: 0, reason: `「${label}」の塊にしか入らない` };
        }
        const eff = c.entries.find((e) => e.position === p)!.effectiveBpm;
        if (!mults.some((m) => Math.abs(eff - t.bpm * m) / (t.bpm * m) <= tol + 1e-9)) {
          const lbl = layout ? `「${layout.blocks[layout.blockAt(p)].label}」の塊の ` : '';
          return { stage: 2, reason: `BPM が遠い（原曲 ${t.bpm.toFixed(1)} / ${lbl}セットは ${Math.round(eff)}。±${(tol * 100).toFixed(0)}% に届かない）` };
        }
        return null;
      },
      solveFixed: (fixed) => solve(pool.tracks, { ...req, n }, weights, curves, { ...solveOpts, fixed, avoid: undefined }).candidates[0] ?? null,
    });
    candidates[ci] = cand;
    // プールに居ない曲（場面・群・札の設定で外れている）は理由つきで並べる。順序は指定どおり
    return found.map((x) => {
      if (typeof x !== 'string') return results.find((r) => r.basename === x.basename)!;
      const d = pool.dropped.find((y) => y.basename === x);
      return { basename: x, title: x, artist: '', position: null, replaced: null, costDelta: null,
        reason: d ? `今の設定では使えない（${d.reason}）` : '曲が見つからない（解析済みの曲に無い）' };
    });
  });
  console.log(`\n使いたい曲（案 1）: ${req.wish.length} 曲を試しました（${Date.now() - tw}ms）`);
  for (const r of wishResults[0]) {
    console.log(r.position != null
      ? `  ✓ ${r.position} 曲目: ${r.title}${r.replaced ? `（「${r.replaced.title}」と入れ替え / cost +${(r.costDelta ?? 0).toFixed(2)}）` : '（もともと入っていた）'}`
      : `  × ${r.title}: ${r.reason}`);
  }
}
// --- 曲が足りないとき。**黙って短いセットを返さない。** ---------------------
//
// 2026-10-03 ユーザー指摘: 「120 分で組んだのに曲が足りず、気づかないまま本番に出る」
// のが一番困る。要求した曲数に届かなかったことを、理由と不足分の時間つきで言う。
// 画面はこの `shortfall` をそのまま出すだけにする（判断を 2 箇所に分けない）。
// **曲数は案ごとに違うことがある**（持ち時間に合わせて案ごとに決め直すため）。
// 案ごとの要求曲数と比べ、一番届いている案で判定する（全案が届かないときだけ不足）
const askedOf = (i: number) => many.results[i]?.n ?? result.n;
const bestFill = candidates
  .map((c, i) => ({ asked: askedOf(i), got: c.entries.length }))
  .reduce((a, b) => (b.got - b.asked > a.got - a.asked ? b : a), { asked: result.n, got: -Infinity });
const askedN = bestFill.asked;
const gotTracks = candidates.length ? bestFill.got : 0;
const shortfall = gotTracks < askedN ? {
  askedTracks: askedN,
  gotTracks,
  askedMinutes: req.minutes ?? null,
  minutesPerTrack: MINUTES_PER_TRACK,
  // 曲数から時間に戻す。**n を出したときと同じ換算を使う**（別の数字を出すと混乱する）
  gotMinutes: req.minutes != null ? Math.round(gotTracks * MINUTES_PER_TRACK) : null,
  missingMinutes: req.minutes != null
    ? Math.max(0, Math.round((askedN - gotTracks) * MINUTES_PER_TRACK)) : null,
  // なぜ尽きたか。beam が出した説明をそのまま渡す
  reason: (result.notes ?? []).find((x: string) => /繋がりません|残っていません/.test(x)) ?? null,
} : null;

if (shortfall) {
  console.log(`\n★ 曲が足りません。${shortfall.askedTracks} 曲を求めて ${shortfall.gotTracks} 曲しか組めませんでした`);
  if (shortfall.missingMinutes != null) {
    console.log(`  指定 ${shortfall.askedMinutes} 分に対して約 ${shortfall.gotMinutes} 分ぶん。**約 ${shortfall.missingMinutes} 分足りません**`);
  }
  if (shortfall.reason) console.log(`  理由: ${shortfall.reason}`);
  console.log('  増やすには: 音の群れを増やす / アニソンを「入れる」/ 時間帯の指定を外す / 箱を変える');
}

// **足した 1 曲が何で、前後のキーとどう繋がるかを言う。** 入れたあと目で確かめられるように。
// candidates が出来てから呼ぶこと（result には entries が無い。2026-10-03 に踏んだ）
if (addInfo) {
  const at = addInfo.position;
  const ents = candidates[0]?.entries ?? [];
  const pick = (p: number) => ents.find((e: any) => e.track && e.position === p);
  const got = pick(at), prevE = pick(at - 1), nextE = pick(at + 1);
  const around = [prevE && `前 ${prevE.track.camelot ?? '??'}`, nextE && `後 ${nextE.track.camelot ?? '??'}`]
    .filter(Boolean).join(' / ');
  console.log(addInfo.kind === 'append'
    ? `\n後ろに 1 曲足しました（${addInfo.before} 曲 → ${addInfo.after} 曲）`
    : `\n${at} 曲目の前に 1 曲入れました（${addInfo.before} 曲 → ${addInfo.after} 曲）`);
  if (got) console.log(`  入れた曲: ${got.track.title} / ${got.track.artist}  key ${got.track.camelot ?? '??'}${around ? `（${around}）` : ''}`);
  else console.log('  ※ 入れられる曲が見つかりませんでした（条件に合う曲がプールに無い）');
}
if (!singleOnly && candidates.length < Number(weights.beam.outputs)) {
  console.log(`  ※ 案は ${candidates.length} つだけです。これ以上ひねっても同じ曲しか残っていません（プールが小さいと起こります）`);
}

// --- ✂ の所につなぎの曲を挿し込む（2026-10-17。ユーザー要求「自動で入れて欲しい」）-----------
//
// **曲数には入れない**（Bridge.afterPosition で曲と曲のあいだに置く別の層）。
// position は差し替え・曲を足す・保存と呼び出し・自己検査の鍵なので、番号をずらさない。
// 合うつなぎが無い ✂ はそのまま残る（カットで切る。今までと同じ）。
const bridgeCut = layout ? layout.boundaries : new Set<number>();
if (layout && pool.transitions.length) {
  const pitchMax = Number(weights.set_bpm?.pitch_tolerance ?? 0.05);
  for (const c of candidates) {
    c.bridges = planBridges(c, pool.transitions, { mixMax, pitchMax, cutAt: bridgeCut });
    // **つなぎが入った所はもうカットではない。** `CUT` の印を残すと
    // 「✂ ここは繋がずに切り替える」と「つなぎで繋ぐ」が同じ場所に並んで矛盾する
    // （画面を撮って気づいた。2026-10-17）。印を `BRIDGED` に差し替える。
    for (const b of c.bridges) {
      const next = c.entries.find((e) => e.position === b.afterPosition + 1);
      if (!next) continue;
      next.flags = next.flags.filter((f) => f !== 'CUT');
      next.flags.push('BRIDGED');
    }
  }
  const nb = candidates[0]?.bridges?.length ?? 0;
  if (bridgeCut.size) {
    console.log(`\nつなぎ: ✂ ${bridgeCut.size} 箇所のうち ${nb} 箇所につなぎの曲を入れました` +
      `（候補 ${pool.transitions.filter((t) => t.transition?.from != null).length} 曲から選択）`);
    for (const b of candidates[0]?.bridges ?? []) {
      console.log(`  ${b.afterPosition} 曲目のあと: ${bridgeLabel(b)}  ${b.track.title}`);
    }
    if (nb < bridgeCut.size) {
      console.log(`  ※ 残り ${bridgeCut.size - nb} 箇所は合うつなぎが無いのでカットのままです`
        + `（両端が ±${(mixMax * 100).toFixed(0)}% に収まる曲が要る）`);
    }
  }
}

// --- 曲数は足りているのに**時間が足りない**ことを見逃させない（2026-10-17 ユーザー報告）--------
//
// 「30 分を 13 曲にしていたが、最後の方で曲が足らなくなる可能性がある」。
// 曲数（13）は満たしているので上の shortfall には出ない。**短い曲が並ぶと実際には 27 分で終わる。**
// ユーザーの判断は「足すのは手でよい。ただし総再生時間を出してほしい」（自動では足さない）。
// だから **何分足りず、何曲足せば届くか**だけを言う。足すのは人が決める。
let timeShort: { askedMinutes: number; realMinutes: number; missingMinutes: number; addTracks: number } | null = null;
if (req.minutes != null && candidates.length) {
  const real = Math.min(...candidates.map((c) => setMinutes(c, timing).total));
  const missing = req.minutes - real;
  // 1 曲ぶん（2.31 分）以上足りないときだけ言う。端数で毎回騒ぐと印として死ぬ
  if (missing >= MINUTES_PER_TRACK) {
    timeShort = {
      askedMinutes: req.minutes, realMinutes: Math.round(real),
      missingMinutes: Math.round(missing), addTracks: Math.ceil(missing / MINUTES_PER_TRACK),
    };
    console.log(`\n★ 曲数は足りていますが、**時間が足りません**。` +
      `持ち時間 ${req.minutes} 分に対して実際は約 ${Math.round(real)} 分です`);
    console.log(`  曲の実長から計算した値です（曲数 x ${MINUTES_PER_TRACK} 分の換算では ` +
      `${Math.round(candidates[0].entries.length * MINUTES_PER_TRACK)} 分に見えます）。選ばれた曲が短いとこうなります`);
    console.log(`  届かせるには **あと ${timeShort.addTracks} 曲**。画面の「後ろに追加」か --append で足せます`);
  }
}

// --- 自己検査: HARD 制約が本当に守られているか。S6 で重みをいじっても壊れないための保険 ---
{
  const tol = Number(weights.hard.bpm_tolerance);
  const violations: string[] = [];
  candidates.forEach((c, ci) => {
    for (let i = 1; i < c.entries.length; i++) {
      const a = c.entries[i - 1].effectiveBpm, b = c.entries[i].effectiveBpm;
      const d = Math.abs(a - b) / Math.min(a, b);
      if (layout?.boundaries.has(i + 1)) continue;   // カットで入る塊は BPM を切り替える前提
      if (d > tol + 1e-9) violations.push(`候補${ci + 1} ${i}->${i + 1} BPM ${a.toFixed(1)}->${b.toFixed(1)} (${(d * 100).toFixed(1)}%)`);
    }
    // **つなぎの両端が本当に繋がっているか。** 自動で挿し込むものなので、ここで必ず検算する。
    // 片側だけ合っていても意味が無い（1 曲なので前後に同じピッチがかかる）
    for (const b of c.bridges ?? []) {
      const prev = c.entries.find((x) => x.position === b.afterPosition);
      const next = c.entries.find((x) => x.position === b.afterPosition + 1);
      if (!prev || !next) { violations.push(`候補${ci + 1} つなぎの置き場所が不正 (${b.afterPosition} 曲目のあと)`); continue; }
      const d1 = Math.abs(b.effFrom - prev.effectiveBpm) / Math.min(b.effFrom, prev.effectiveBpm);
      const d2 = Math.abs(b.effTo - next.effectiveBpm) / Math.min(b.effTo, next.effectiveBpm);
      if (d1 > mixMax + 1e-9 || d2 > mixMax + 1e-9)
        violations.push(`候補${ci + 1} つなぎ ${b.from}→${b.to} が繋がっていない（前 ${(d1 * 100).toFixed(1)}% / 後 ${(d2 * 100).toFixed(1)}%、上限 ${(mixMax * 100).toFixed(0)}%）: ${b.track.title}`);
      // ピッチをかけたあとの BPM が原曲 x (1+pitch) と合っているか（計算の取り違え検出）
      if (Math.abs(b.from * (1 + b.pitch) - b.effFrom) > 0.05 || Math.abs(b.to * (1 + b.pitch) - b.effTo) > 0.05)
        violations.push(`候補${ci + 1} つなぎの BPM の計算が合わない: ${b.track.title}`);
      // つなぎが普通の曲としても入っていないか（二重に鳴らすことになる）
      if (c.entries.some((x) => x.track.key === b.track.key))
        violations.push(`候補${ci + 1} つなぎの曲が本編にも入っている: ${b.track.title}`);
    }
    if (c.bridges && new Set(c.bridges.map((b) => b.track.key)).size !== c.bridges.length)
      violations.push(`候補${ci + 1} 同じつなぎを 2 回使っている`);
    for (const e of c.entries) {
      // 長いセット: その塊の札の曲か
      if (layout && !layout.allowAt(e.position, e.track))
        violations.push(`候補${ci + 1} #${e.position} 塊「${layout.blocks[layout.blockAt(e.position)].label}」の札でない曲: ${e.track.title}`);
      const eb = req.bpm_band;
      if (eb && (e.effectiveBpm < eb[0] - 1e-9 || e.effectiveBpm > eb[1] + 1e-9))
        violations.push(`候補${ci + 1} #${e.position} BPM ${e.effectiveBpm.toFixed(1)} が band 外`);
      // ピッチの上限。**セットの BPM を決めたときの一番大事な HARD 制約**なので必ず検算する
      const pTol = Number(weights.set_bpm?.pitch_tolerance ?? 0.05);
      if (req.set_bpm != null && Math.abs(e.pitch ?? 0) > pTol + 1e-9)
        violations.push(`候補${ci + 1} #${e.position} ピッチ ${((e.pitch) * 100).toFixed(1)}% が上限 ±${(pTol * 100).toFixed(0)}% を超えている: ${e.track.title}`);
      // 実際にかける BPM が原曲 x 倍率 x (1+pitch) と合っているか（計算の取り違え検出）
      if (req.set_bpm != null) {
        const expect = e.track.bpm * e.multiplier * (1 + (e.pitch ?? 0));
        if (Math.abs(expect - e.effectiveBpm) > 0.05)
          violations.push(`候補${ci + 1} #${e.position} BPM の計算が合わない（原曲 ${e.track.bpm.toFixed(1)} x${e.multiplier} +${((e.pitch) * 100).toFixed(1)}% = ${expect.toFixed(1)} だが ${e.effectiveBpm.toFixed(1)} と出ている）`);
      }
      // **場面の除外は「実際に適用した値」で検算する。**
      // ctx.exclude_tags をそのまま見ると、--anime include/only で打ち消した分を
      // 検査だけが知らずに違反と判定する（実際にそうなった。検査が拾ってくれた例）
      for (const tag of onlyMode ? [] : e.track.contextTags) {
        if (ctxExcludeTags.includes(tag))
          violations.push(`候補${ci + 1} #${e.position} この場面で使えない曲が入っている (${tag}): ${e.track.title}`);
        const min = (ctx.position_min ?? {})[tag];
        if (min != null && e.position < Number(min))
          violations.push(`候補${ci + 1} #${e.position} ${tag} が ${min} 曲目より前`);
      }
      if (c.entries.filter((x) => x.track.key === e.track.key).length > 1)
        violations.push(`候補${ci + 1} 同じ曲が 2 回出ている: ${e.track.title}`);
      const dupCos = Number(weights.hard.timbre_duplicate_cosine ?? 0);
      if (dupCos) for (const o of c.entries) {
        if (o.position <= e.position) continue;
        let dot = 0;
        for (let i = 0; i < e.track.timbre.length; i++) dot += e.track.timbre[i] * o.track.timbre[i];
        if (dot > dupCos) violations.push(`候補${ci + 1} #${e.position} と #${o.position} が同じ録音 (cos ${dot.toFixed(4)}): ${e.track.title}`);
      }
      if (weights.hard.same_title !== true && e.track.titleKey &&
          c.entries.filter((x) => x.track.titleKey === e.track.titleKey).length > 1)
        violations.push(`候補${ci + 1} 同じ曲の別バージョンが入っている: ${e.track.title}`);
    }
    const la = weights.hard.max_per_artist_long;
    const maxArtist = (la && c.entries.length >= Number(la.from_tracks) ? Number(la.max) : Number(weights.hard.max_per_artist ?? 0)) || Infinity;
    const byArtist = new Map<string, number>();
    for (const e of c.entries) for (const a of e.track.artistNames) byArtist.set(a, (byArtist.get(a) ?? 0) + 1);
    for (const [a, cnt] of byArtist) if (cnt > maxArtist) violations.push(`候補${ci + 1} ${a} が ${cnt} 曲（上限 ${maxArtist}）`);
    if (weights.hard.same_artist_adjacent !== true) {
      for (let i = 1; i < c.entries.length; i++) {
        const b = c.entries[i].track.artistNames;
        const a = c.entries[i - 1].track.artistNames.find((x) => b.includes(x));
        if (a) violations.push(`候補${ci + 1} ${i}->${i + 1} 同じアーティストが連続: ${a}`);
      }
    }
  });
  // **「足した」と報告したなら本当に増えていること。**（2026-10-17）
  // 長いセットで「26 曲 -> 27 曲」と報告しながら 26 曲のままになっていた。
  // 画面はこの報告をそのまま人に見せるので、食い違ったまま通すのが一番危ない。
  // **「前の曲に戻した」と報告したなら、本当にその曲がその位置に居ること。**（2026-10-21）
  // 名指しの操作なので、違う曲が入っていたら黙って通してはいけない
  if (putInfo) {
    for (const [ci, c] of candidates.entries()) {
      const got = c.entries.find((e) => e.position === putInfo!.position);
      if (got?.track.basename !== putInfo.basename) {
        violations.push(`候補${ci + 1} ${putInfo.position} 曲目に「${putInfo.basename}」を戻すと報告しているのに「${got?.track.basename ?? 'なし'}」`);
      }
      if (c.entries.length !== putInfo.position && c.entries.length < putInfo.position) {
        violations.push(`候補${ci + 1} ${putInfo.position} 曲目が無い（${c.entries.length} 曲）`);
      }
    }
  }
  if (addInfo) {
    for (const [ci, c] of candidates.entries()) {
      if (c.entries.length !== addInfo.after) {
        violations.push(`候補${ci + 1} 「${addInfo.before} 曲 -> ${addInfo.after} 曲」と報告しているのに ${c.entries.length} 曲`);
      }
    }
  }
  if (violations.length) {
    console.error('\n【自己検査 NG】HARD 制約が破れています。solver のバグです:');
    for (const v of [...new Set(violations)]) console.error('  ' + v);
    process.exitCode = 3;
  }
}

mkdirSync(outDir, { recursive: true });

// **out/ は作業場。** 実行のたびに増えるので、古いものは自動で捨てる。
// 残したいものは画面の「このセトリを書き出す」で別の場所へ保存する
// （2026-08-08 ユーザー指摘:「out には常に書き出されていて、どれが選ぶものか分からなくなる」）。
{
  const keepDays = Number(weights.out_keep_days ?? 7);
  const limit = Date.now() - keepDays * 86400_000;
  try {
    let removed = 0;
    for (const f of readdirSync(outDir)) {
      if (!/^setlist_/.test(f)) continue;
      const full = join(outDir, f);
      if (statSync(full).mtimeMs < limit) { unlinkSync(full); removed++; }
    }
    if (removed) console.log(`out/ の ${keepDays} 日より古い作業ファイル ${removed} 件を消しました`);
  } catch { /* 掃除に失敗しても本題ではないので黙って続ける */ }
}

// --- 出力のファイル名。**必ず他と違う名前にする。** ---
//
// 以前は秒までだった（`.slice(0, 19)`）。solver は小さいプールだと 200ms で終わるので、
// 連続して操作すると**同じ名前になって前の結果を上書きしていた**。
// 画面の「替える」「ここまで確定」は案ごとに `_src = { json, idx }` で前の結果 JSON を
// 指しているので、上書きされると**別の中身を読んで案が壊れる**。
// ミリ秒まで入れ、それでも在ったら連番を足す（2026-10-03。test-edit.js が掘り出した）。
const stampBase = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
let stamp = stampBase;
for (let i = 2; existsSync(join(outDir, `setlist_${stamp}.json`)); i++) stamp = `${stampBase}-${i}`;

candidates.forEach((c, i) => {
  const diff = i > 0 ? `  （前の案と ${Math.round((1 - many.overlaps[i]) * 100)}% 違う）` : '';
  console.log(`\n─── 案 ${i + 1} ───────────────────────────────────────────────────────${diff}`);
  // 目標の曲線は案ごとに取る（持ち時間に合わせて案ごとに曲数が違うことがある）
  console.log(formatTable(c, many.results[i]?.targets ?? result.targets, new Map(pool.soundGroupLabels.map((g) => [g.id, g.label])), Number(weights.block?.min ?? 3), MINUTES_PER_TRACK,
    layout ? new Map(layout.blocks.map((b) => [b.start, `${b.cut ? '✂ ' : ''}${b.index + 1}. ${b.label}  ${b.bpm} BPM`])) : undefined,
    timing));
  const base = `setlist_${stamp}_${i + 1}`;
  writeFileSync(join(outDir, base + '.xml'), rekordboxXml(c, base));
  writeFileSync(join(outDir, base + '.m3u8'), m3u(c));
});

const groupLabel = new Map(pool.soundGroupLabels.map((g) => [g.id, g.label]));
const payload = {
  request: req, analyzerVersion: pool.analyzerVersion, poolSize: pool.tracks.length,
  setBpm: req.set_bpm ?? null,
  setBpmAuto: autoBpmNote,
  pitchTolerance: Number(weights.set_bpm?.pitch_tolerance ?? 0.05),
  pitchComfort: Number(weights.set_bpm?.pitch_comfort ?? 0.03),
  anime: animeMode,
  seed: req.seed ?? null,
  // 画面の選択 UI に出す内容。曲数つき
  soundGroups: pool.soundGroupLabels.map((g) => ({
    ...g, count: pool.tracks.filter((t) => t.soundGroup === g.id).length,
  })),
  notes: result.notes,
  // **曲が足りないことを画面に伝える。** null なら足りている
  shortfall,
  // **曲数は足りているのに時間が足りないことを画面に伝える。** null なら足りている（2026-10-17）
  timeShort,
  askedTracks: result.n,
  askedMinutes: req.minutes ?? null,
  minutesPerTrack: MINUTES_PER_TRACK,
  // 総再生時間の計算に使った値。画面は自分で計算せず solver の数字をそのまま出す
  timing,
  // 曲を足したときの情報。画面がそのまま報告に使う（画面でロジックを持たないため）
  added: addInfo,
  // 「履歴から前の曲に戻した」結果。指定が無ければ null
  restored: putInfo,
  // 長いセットの塊。画面の帯・区切り線・「この塊を選び直す / 札を替える」に使う
  blocks: layout ? layout.blocks.map((b) => ({
    index: b.index, card: b.card, label: b.label, level: b.level, start: b.start, end: b.end, n: b.n,
    bpm: b.bpm, cut: b.cut,
  })) : null,
  // 札の一覧（曲数つき）。画面の「今日使ってよいジャンル」のチェック欄に出す
  cards: cardsCfg.cards.map((c: any) => ({
    id: c.id, label: c.label, level: c.level, on: palette.includes(c.id), default_on: !!c.default_on, anime: !!c.anime,
  })),
  refilled: refill ? [...refill] : null,
  stamp,
  outDir,
  candidates: candidates.map((c, i) => ({
    totalCost: c.totalCost, manualChecks: c.manualChecks,
    // この案の要求曲数。短い曲が多い案は持ち時間に届くよう足すので、上の askedTracks より多いことがある
    askedTracks: askedOf(i),
    // 使いたい曲をどこに入れたか / 入れなかった理由。指定が無ければ null
    wishes: wishResults?.[i] ?? null,
    // **総再生時間。** 曲数 x 2.31 分の見込みではなく曲の実長から出した数字（export.ts の setMinutes）。
    // minutes = 実際にかかる分 / rawMinutes = 曲の実長の合計 / overlapMinutes = 引いた重なり
    minutes: Math.round(setMinutes(c, timing).total),
    rawMinutes: Math.round(setMinutes(c, timing).raw),
    planMinutes: Math.round(c.entries.length * MINUTES_PER_TRACK),
    // ✂ に挿し込んだつなぎの曲。**曲番は持たない**（afterPosition 曲目と次の曲のあいだ）。
    // 画面はこれを色を変えて挟んで描く（ユーザー要求「トランジションだと分かるように色を変えて」）
    bridges: (c.bridges ?? []).map((b) => ({
      afterPosition: b.afterPosition, title: b.track.title, artist: b.track.artist,
      basename: b.track.basename, from: b.from, to: b.to, pitch: b.pitch,
      bpmFrom: b.effFrom, bpmTo: b.effTo, camelot: b.track.camelot,
      path: b.track.path, duration: b.track.duration, windowStart: b.track.windowStart,
      label: bridgeLabel(b),
    })),
    // 案ごとの書き出し済みファイル。画面の「rekordbox に書き出す」はこれを指す
    files: { xml: join(outDir, `setlist_${stamp}_${i + 1}.xml`), m3u: join(outDir, `setlist_${stamp}_${i + 1}.m3u8`) },
    entries: c.entries.map((e) => ({
      position: e.position, title: e.track.title, artist: e.track.artist, basename: e.track.basename,
      // bpm = 実際にかける速度 / naturalBpm = 原曲 / pitch = その差（0.03 = +3%）
      bpm: e.effectiveBpm, naturalBpm: e.track.bpm * e.multiplier, pitch: e.pitch,
      multiplier: e.multiplier, camelot: e.track.camelot,
      isAnime: e.track.isAnime,
      energy: e.track.energy, groove: e.track.groove,
      // 試聴に使う。**Windows のパス**（collection.xml の値そのまま。作り直してはいけない）
      path: e.track.path,
      // 試聴の頭出し位置（秒）。イントロからではなく「その曲らしい」ところから鳴らす
      windowStart: e.track.windowStart,
      duration: e.track.duration,
      soundGroup: e.track.soundGroup,
      soundGroupLabel: groupLabel.get(e.track.soundGroup) ?? e.track.soundGroup,
      soundCell: e.track.soundCell,
      block: e.block ?? null,
      // **その曲が属する札。** 長いセットで「塊の中身が本当にその札の曲か」を
      // 外から確かめられるようにするため（scripts/qa-longset.js が使う）。
      // 位置から決めるのではなく曲から引くので、入れる側の間違いを拾える。
      card: cardOfTrack.size ? (cardOfTrack.get(e.track.key) ?? null) : null,
      flags: [...new Set([...e.track.flags, ...e.flags])],
    })),
  })),
};
const jsonPath = join(outDir, `setlist_${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

console.log(`\n出力: ${outDir}/setlist_${stamp}_*.xml (rekordbox) / *.m3u8 / *.json`);
console.log('rekordbox への取り込み: ファイル > 読み込み > コレクション XML を読み込み → プレイリストに現れます');

// --json のときだけ、標準出力に JSON を出す（画面がこれを読む）
if (jsonMode) process.stdout.write(JSON.stringify({ ...payload, jsonPath }));
