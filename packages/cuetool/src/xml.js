// Ｑ入りの rekordbox XML を書く。**書き換えるのは POSITION_MARK だけ。**
//
// ■ 作り方: `data/collection.xml` の TRACK のかたまりを**そのまま写し**、
//   `</TRACK>` の直前に `<POSITION_MARK>` を挿すだけ。属性は 1 つも作らない。
//
// ■ なぜそうするか（2026-10-19 にユーザーが決めた「Ｑ用 XML から BPM 欄を外す」の実装）
//
//   取り込みのダイアログは明言している: **「解析ロックされている楽曲の拍位置情報と
//   キー情報は読み込みません」** = ロックしていない曲の**拍位置とキーは上書きされうる**。
//   solver の通常の書き出し（`rekordboxXml`）は `AverageBpm` に**実測値**を入れるため
//   （レコボ 200 に対し 99.03 など 53 曲中 19 曲）、同じ作りでＱを送ると
//   **グリッドが動く恐れがある。** 動くかどうかは未確認のまま。
//
//   そこで**こちらの値を 1 つも持ち込まない**。写した `AverageBpm` は rekordbox 自身の値、
//   写した `<TEMPO>` は rekordbox 自身のグリッド。**同じ値を書き戻すので上書きが起きない。**
//   これが「BPM 欄を外す」の意図（= 実測値を送り込まない）を、取り込みの実績がある形
//   （ゲートを通した `scripts/cue/gate-xml.js` と同じ作り）のまま満たす方法。
//
//   属性を**消す**選択もあったが採らなかった: `AverageBpm` や `<TEMPO>` が無い TRACK を
//   rekordbox がどう扱うかは未確認で、BPM 0 になる可能性を排除できない。
//   **実績のある形を崩さない方を選ぶ**（docs/DECISIONS.md 2026-10-20）。
//
// ■ `data/collection.xml` には**絶対に書かない**。出力は `out/` の別ファイル。
//   取り込みで事故っても元の XML が無傷なら rekordbox 側を作り直せる（退路を残す）。

export function xmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * TRACK のかたまりに POSITION_MARK を挿す。**他は 1 文字も変えない。**
 *
 * `Type="0"` = メモリーキュー / `Num="-1"` = ホットキューではない。
 * この 2 つの組み合わせでゲートを通した（2026-10-19 実機）。変えないこと。
 */
export function spliceCues(block, cues) {
  if (!cues.length) return block;
  // **元の字下げに合わせる。** `</TRACK>` の行と、既にある子要素（TEMPO）の行から取る。
  // 固定値にすると、元の XML の見た目が変わって「写しただけ」の確認が目でできなくなる
  const closeIndent = (block.match(/\n([ \t]*)<\/TRACK>/) ?? [, '    '])[1];
  const childIndent = (block.match(/\n([ \t]*)<(?:TEMPO|POSITION_MARK)\b/) ?? [, `${closeIndent}  `])[1];
  const marks = cues.map((c) =>
    `${childIndent}<POSITION_MARK Name="${xmlEscape(c.label)}" Type="0" ` +
    `Start="${c.sec.toFixed(3)}" Num="-1"/>`).join('\n');
  if (/\n[ \t]*<\/TRACK>/.test(block)) {
    return block.replace(/\n[ \t]*<\/TRACK>/, `\n${marks}\n${closeIndent}</TRACK>`);
  }
  if (block.includes('</TRACK>')) return block.replace('</TRACK>', `\n${marks}\n</TRACK>`);
  // 自己終了タグ（`<TRACK ... />`）は開き閉じに開く。ここを通るのは TEMPO が無い曲なので
  // 実際には cuesForTrack が先に落とすが、作りとして閉じておく
  return block.replace(/\/>\s*$/, `>\n${marks}\n</TRACK>`);
}

/**
 * 取り込み用の XML 1 本。
 *
 * @param entries [{ block, cues }] かける順。**Ｑを打った曲だけ**を渡すこと
 *   （ユーザー指示 2026-10-21。曲の並びは `.m3u8` が渡すので、ここはＱを配るためだけの道具。
 *   旧ルール「曲は消えてはいけない」は、普通の書き出しを m3u8 に分けた時点で用済み）
 * @param name    rekordbox のツリーに出るプレイリスト名
 */
export function cueXml(entries, name) {
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<DJ_PLAYLISTS Version="1.0.0">');
  L.push('  <PRODUCT Name="dj-setlist" Version="0.1.0" Company="local"/>');
  L.push(`  <COLLECTION Entries="${entries.length}">`);
  for (const e of entries) {
    L.push('    ' + spliceCues(e.block, e.cues ?? []).trim());
  }
  L.push('  </COLLECTION>');
  L.push('  <PLAYLISTS>');
  L.push('    <NODE Type="0" Name="ROOT" Count="1">');
  L.push(`      <NODE Name="${xmlEscape(name)}" Type="1" KeyType="0" Entries="${entries.length}">`);
  for (const e of entries) L.push(`        <TRACK Key="${xmlEscape(e.trackId)}"/>`);
  L.push('      </NODE>');
  L.push('    </NODE>');
  L.push('  </PLAYLISTS>');
  L.push('</DJ_PLAYLISTS>');
  return L.join('\n') + '\n';
}
