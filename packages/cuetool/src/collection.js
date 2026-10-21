// `data/collection.xml` を**読むだけ**の層。
//
// 約束（docs/DECISIONS.md 2026-10-17 の追記「Ｑを打っても collection.xml には追記しない」）:
//   `data/collection.xml` は rekordbox から書き出した**読み取り専用の資料**。
//   この層に書き込みの関数を足さないこと。Ｑ入りの XML は `out/` に別ファイルで作る。
//
// 曲の引き当ては **`Size`(bytes) + basename**（Project Hard Constraints 2）。
// 絶対パスで引くと Mac `/Volumes/...` と Win `C:\...` が乖離する。

import { readFileSync } from 'node:fs';

/** `<TRACK TrackID=...>` 1 曲ぶんのかたまりに切る。自己終了タグの曲も 1 件として返す */
export function splitTracks(xml) {
  const out = [];
  for (const chunk of xml.split(/(?=<TRACK TrackID=)/).slice(1)) {
    const end = chunk.indexOf('</TRACK>');
    // `</TRACK>` が無い = 自己終了タグ（`<TRACK ... />`）。TEMPO も POSITION_MARK も持たない
    out.push(end >= 0 ? chunk.slice(0, end + 8) : chunk.slice(0, chunk.indexOf('/>') + 2));
  }
  return out;
}

/** 開始タグの属性だけを見る。中の POSITION_MARK などに引っかからないように頭で切る */
export function attr(block, name) {
  const head = block.slice(0, block.indexOf('>') + 1);
  const m = head.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** XML の実体参照を戻す。表示と照合に使う（書き出しには使わない） */
export function unescapeXml(s) {
  return (s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** `file://localhost/...` → OS のパス。**作り直さず decode するだけ** */
export function locationPath(block) {
  const loc = attr(block, 'Location');
  if (!loc) return null;
  const m = loc.match(/^file:\/\/localhost\/(.*)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function basenameOf(block) {
  const p = locationPath(block);
  return p ? p.split(/[\\/]/).pop() : null;
}

/** 引き当ての鍵。`Size` が無い曲は basename だけで引く（鍵が弱いことを呼び出し側に見せる） */
export function joinKey(size, basename) {
  return `${size ?? ''}/${basename ?? ''}`;
}

/**
 * **メモリーＱ／ホットキューが 1 つでもあるか。**
 *
 * 安全の規則（ユーザー要求 2026-10-17）: 既にＱがある曲には書き出さない。
 * 判定は `POSITION_MARK` の有無で、**メモリーＱ(Num=-1)に限らない**。
 * ホットキューだけの曲も触らない方に倒す（取り込みが置き換える実装だった場合に壊さない）。
 */
export function hasCues(block) {
  return /<POSITION_MARK/.test(block);
}

/** `<TEMPO Inizio Bpm Metro Battito>` を順に。**可変グリッドの曲が 692 ある** */
export function tempoOf(block) {
  return [...block.matchAll(/<TEMPO Inizio="([\d.]+)" Bpm="([\d.]+)" Metro="([^"]*)" Battito="(\d+)"/g)]
    .map((m) => ({ i: +m[1], bpm: +m[2], bat: +m[4] }));
}

/**
 * collection.xml を読んで `Size`+basename で引ける形にする。
 * @returns {{ blocks: string[], byKey: Map<string, string> }}
 */
export function loadCollection(path) {
  const blocks = splitTracks(readFileSync(path, 'utf8'));
  const byKey = new Map();
  for (const b of blocks) {
    const k = joinKey(attr(b, 'Size'), basenameOf(b));
    // 二重登録（実測 4 件）は**先に出てきた方を採る**。ingest 側と同じ扱い
    if (!byKey.has(k)) byKey.set(k, b);
  }
  return { blocks, byKey };
}

/**
 * セットリストの XML（solver が `out/` に書いたもの）から**かける順**に曲を読む。
 * PLAYLISTS の並びを正本にする（COLLECTION 側の順と食い違っても現場の順が勝つ）。
 */
export function readSetlist(path) {
  const xml = readFileSync(path, 'utf8');
  const byId = new Map();
  for (const b of splitTracks(xml)) byId.set(attr(b, 'TrackID'), b);
  const order = [...xml.matchAll(/<TRACK Key="([^"]*)"\/>/g)].map((m) => m[1]);
  const seen = new Set();
  const out = [];
  for (const id of order) {
    const b = byId.get(id);
    if (!b) continue;
    out.push({
      trackId: id,
      size: attr(b, 'Size'),
      basename: basenameOf(b),
      name: unescapeXml(attr(b, 'Name')),
      artist: unescapeXml(attr(b, 'Artist')),
    });
    seen.add(id);
  }
  // プレイリストに出ていない曲（あれば）も落とさない。順は COLLECTION の並び
  for (const [id, b] of byId) {
    if (seen.has(id)) continue;
    out.push({
      trackId: id, size: attr(b, 'Size'), basename: basenameOf(b),
      name: unescapeXml(attr(b, 'Name')), artist: unescapeXml(attr(b, 'Artist')),
    });
  }
  return out;
}
