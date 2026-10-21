// セットリストに**メモリーＱを打った XML** を作る。
//
//   node packages/cuetool/src/cli.js --setlist out/setlist_xxx_1.xml
//   node packages/cuetool/src/cli.js --setlist out/setlist_xxx_1.xml --json   # 画面用
//   node packages/cuetool/src/cli.js --pick "don't lose"                      # 1 曲だけ試す
//
// 出力は `out/<元の名前>_cue.xml`。**元の XML も data/collection.xml も書き換えない。**
//
// ■ なぜ「書き出しの横のボタン」なのか（ユーザー指示 2026-10-17）
//   普通の書き出しは今のまま（Ｑを一切書かない）。Ｑ入りは**押したときだけ**作る。
//   帰結: 既存の経路が壊れない / 全 4111 曲の一括解析が不要（押したセットの 13-52 曲だけ）。
//
// ■ 速さ: 全長デコード + 構造解析で 1 曲 0.3 秒。26 曲で約 8 秒。**待てる。**

import { writeFileSync, writeSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadCollection, readSetlist, attr, joinKey, basenameOf, unescapeXml } from './collection.js';
import { cuesForTrack, measuredBpmMap } from './cues.js';
import { cueXml } from './xml.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);

const SETLIST = arg('setlist', null);
const PICK = arg('pick', null);
const COLLECTION = arg('collection', 'data/collection.xml');
const DB = arg('db', 'data/features.db');
const JSON_MODE = has('json');

const die = (msg) => {
  // **同期で書いてから終える。** Mac のパイプは非同期で、write 直後の exit は JSON を切る（2026-10-21）。
  // 1 行の短い文なのでパイプの容量に収まる
  if (JSON_MODE) writeSync(1, JSON.stringify({ ok: false, error: msg }));
  else console.error(msg);
  process.exit(1);
};

if (!SETLIST && !PICK) die('--setlist <out/setlist_*.xml> か --pick <曲名の一部> を指定してください');
if (SETLIST && !existsSync(SETLIST)) die(`セットリストの XML が見つかりません: ${SETLIST}`);
if (!existsSync(COLLECTION)) die(`コレクションの XML が見つかりません: ${COLLECTION}`);

const { blocks, byKey } = loadCollection(COLLECTION);
// 実測 BPM（倍/半分のグリッドを直すのに使う）。DB が無くても動く — その場合は直さない
let measured = new Map();
if (existsSync(DB)) {
  try { measured = measuredBpmMap(DB); }
  catch (e) { if (!JSON_MODE) console.error(`※ features.db を読めませんでした（グリッドの倍/半分は直しません）: ${e.message}`); }
} else if (!JSON_MODE) {
  console.error(`※ ${DB} が無いのでグリッドの倍/半分は直しません`);
}

/** 対象の曲（collection.xml のかたまり）をかける順に集める */
let targets;
let outName;
if (SETLIST) {
  const wanted = readSetlist(SETLIST);
  targets = wanted.map((w) => {
    const block = byKey.get(joinKey(w.size, w.basename))
      // Size が食い違う場合（タグを書き換えると変わる）は basename だけで引き直す
      ?? blocks.find((b) => basenameOf(b) === w.basename);
    return { ...w, block: block ?? null };
  });
  outName = basename(SETLIST).replace(/\.xml$/i, '');
} else {
  const want = PICK.toLowerCase();
  const hit = blocks.filter((b) => unescapeXml(
    `${attr(b, 'Name') ?? ''} ${attr(b, 'Artist') ?? ''}`).toLowerCase().includes(want));
  if (!hit.length) die(`「${PICK}」に当たる曲がありません`);
  // **候補を黙って 1 件に絞らない**（曖昧一致の事故は原因が分かりにくい。2026-W32 の教訓）
  if (hit.length > 1 && !JSON_MODE) {
    console.log(`「${PICK}」に ${hit.length} 曲当たりました。全部に打ちます:`);
    for (const b of hit) console.log(`  ${unescapeXml(attr(b, 'Name'))} / ${unescapeXml(attr(b, 'Artist'))}`);
    console.log('');
  }
  targets = hit.map((b) => ({
    block: b, size: attr(b, 'Size'), basename: basenameOf(b),
    name: unescapeXml(attr(b, 'Name')), artist: unescapeXml(attr(b, 'Artist')),
  }));
  outName = 'cue_pick';
}

const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
const entries = [];
const report = [];
const t0 = Date.now();

for (const t of targets) {
  if (!t.block) {
    report.push({ name: t.name, artist: t.artist, ok: false, reason: 'コレクションに見つかりません' });
    continue;
  }
  const r = cuesForTrack(t.block, measured.get(t.basename));
  // **Ｑが打てなくても曲はセットに残す**（ユーザー要求: セットから曲が消えてはいけない）
  // **Ｑを打った曲だけを XML に入れる**（ユーザー指示 2026-10-21）。
  //
  // 以前は打てなかった曲も入れていた。理由は「曲がセットから消えてはいけない」だったが、
  // **10-21 に普通の書き出しを `.m3u8`（プレイリスト）へ分けた時点でその理由は消えた**
  // — 曲の並びはプレイリストが渡すので、この XML は**Ｑを配るためだけの道具**。
  // ユーザーの言葉:「あとでどのみちプレイリストも飲み込むので、キューを打たなければ
  // いけないものだけが xml にあると好都合」。
  // 帰結: 既にＱがある曲・グリッドが無い曲は XML に出てこない = **触る対象が減って安全**。
  if (r.ok && r.cues.length) {
    entries.push({ trackId: attr(t.block, 'TrackID'), block: t.block, cues: r.cues });
  }
  report.push({
    name: t.name, artist: t.artist, ok: r.ok, reason: r.reason ?? null,
    bars: r.bars ?? null, dropped: r.dropped ?? [], mainBars: r.mainBars ?? 0,
    cues: (r.cues ?? []).map((c) => ({ label: c.label, bar: c.bar + 1, sec: +c.sec.toFixed(3) })),
  });
  if (!JSON_MODE) process.stderr.write(`  ${report.length}/${targets.length} 曲…\r`);
}

const outDir = SETLIST ? dirname(SETLIST) : 'out';
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${outName}_cue.xml`);
// **プレイリスト名に「Ｑ」を入れる。** レコボのツリーで普通の書き出しと見分けられるように
writeFileSync(outPath, cueXml(entries, `${outName} (Ｑ)`));

const wrote = report.filter((r) => r.ok).length;
const skipped = report.filter((r) => !r.ok);

if (JSON_MODE) {
  process.stdout.write(JSON.stringify({
    ok: true, out: outPath, tracks: report.length, wrote, skipped: skipped.length, report,
  }));
} else {
  console.log(`\n書き出し: ${outPath}   （${(Date.now() - t0) / 1000 | 0} 秒）\n`);
  console.log(`曲 ${report.length} 件 / Ｑを打った ${wrote} 件 / 打たなかった ${skipped.length} 件`);
  console.log(`XML に入れたのは Ｑを打った ${entries.length} 曲だけ（曲の並びはプレイリストが渡すので、この XML はＱを配る道具）\n`);
  for (const r of report) {
    const head = `${r.ok ? '○' : '—'} ${r.name}${r.artist ? ` / ${r.artist}` : ''}`;
    if (!r.ok) { console.log(`${head}\n    ${r.reason}`); continue; }
    console.log(head);
    console.log('    ' + r.cues.map((c) => `${c.label} ${mmss(c.sec)}(${c.bar}小節)`).join('  '));
    // **盛り上がりが 8 小節何個分か**を数字でも出す（ユーザー要求 2026-10-21）
    if (r.mainBars) console.log(`    メイン（盛り上がり）= 8 小節 x ${r.mainBars} 個分`);
    if (r.dropped.length) console.log(`    打たなかったＱ: ${r.dropped.join(' / ')}`);
  }
  console.log('\n取り込み: rekordbox の「読み込み用ライブラリ」にこの XML を指定 → ツリーから曲を取り込む');
  console.log('      既存曲には「タグ情報を読み込みますか？」→ **はい** でＱがマージされます');
  console.log('※ 本人の手打ち 189 曲と比べたカバー率 34% / 的中率 41%（node scripts/cue/eval.js）。**目で直す前提**');
  console.log('※ 解析ロックしていない曲は拍位置とキーが上書きされうる（この XML は元の値を');
  console.log('   そのまま書き戻すので値は変わりませんが、ロックしておく方が安全です）');
}
