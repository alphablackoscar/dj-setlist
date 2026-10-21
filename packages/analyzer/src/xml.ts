// rekordbox コレクション XML の読み取り。
// 依存を足さないため属性を正規表現で拾う。属性は必ず " で囲まれる。
//
// **1 要素 1 行ではない。** rekordbox は TRACK の属性を複数行に折り返して書く
// （7.2.16 / 7.2.19 の実データで確認。2026-10-03 に以前の「1 要素 1 行」という記述を訂正）。
// `[^>]` は改行も食うので今の正規表現は折り返しを跨げている。**行単位の処理に書き換えないこと。**

import { readFileSync } from 'node:fs';
import { basename as pathBasename } from 'node:path';
import type { XmlTrack } from './types.ts';

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function unescapeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

/**
 * Location="file://localhost/C:/Users/..." を実パスに戻す。
 * URL エンコードされているのでデコードし、Windows なら先頭スラッシュを落とす。
 */
export function locationToPath(location: string): string {
  let s = unescapeXml(location);
  s = s.replace(/^file:\/\/localhost/, '').replace(/^file:\/\//, '');
  try { s = decodeURIComponent(s); } catch { /* 壊れたエンコードはそのまま */ }
  // "/C:/..." -> "C:/..."
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  return s;
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : '';
}

export interface ParseOptions {
  /** XML 内のルートを実フォルダに読み替える。例: ["C:/Users/<user>/Music/", "D:/Music/"] */
  audioRootFrom?: string;
  audioRootTo?: string;
}

export function parseCollection(xmlPath: string, opts: ParseOptions = {}): XmlTrack[] {
  const xml = readFileSync(xmlPath, 'utf8');
  const tracks: XmlTrack[] = [];

  // <COLLECTION> 配下の TRACK のみ。<PLAYLISTS> 側の TRACK は Key 参照だけで属性を持たない
  const collection = xml.slice(xml.indexOf('<COLLECTION'), xml.indexOf('</COLLECTION>') + 1);
  const source = collection.length > 20 ? collection : xml;

  let noSize = 0;
  for (const m of source.matchAll(/<TRACK\s([^>]*?)\/?>/g)) {
    const tag = m[0];
    const location = attr(tag, 'Location');
    if (!location) continue;                 // 属性を持たない TRACK 参照は無視
    const path = applyRoot(locationToPath(location), opts);
    const size = Number(attr(tag, 'Size') || 0);
    // **Size が無い行は捨てる。** 結合キーが `Size|basename` なので、Size が 0 だと
    // 同じファイルが `0|名前` と `実サイズ|名前` の 2 行になり、同じ音源を 2 回解析する。
    // さらに別ファイルどうしが `0|同じ名前` で衝突し、特徴量を上書きし合う。
    // 実データ 3993 曲では 0 件（2026-10-03 実測）なので実害は無いが、黙って壊れるより落とす。
    if (!(size > 0)) { noSize++; continue; }
    const bpm = Number(attr(tag, 'AverageBpm') || 0);
    const total = Number(attr(tag, 'TotalTime') || 0);
    tracks.push({
      trackId: attr(tag, 'TrackID'),
      title: attr(tag, 'Name'),
      artist: attr(tag, 'Artist'),
      genre: attr(tag, 'Genre'),
      xmlBpm: bpm > 0 ? bpm : null,
      xmlKey: attr(tag, 'Tonality'),
      size,
      basename: pathBasename(path),
      path,
      totalTime: total > 0 ? total : null,
    });
  }
  if (noSize) console.log(`XML に Size を持たない行が ${noSize} 件ありました。結合キーが作れないため除きます`);
  return dedupeByKey(tracks);
}

/**
 * 結合キー（Size + basename）が同じエントリを 1 本にまとめる。
 *
 * **rekordbox は同じファイルを二重登録することがある。** 実データ 3961 曲で 2 組見つかった
 * （2026-08-08）。パスまで完全に同一で TrackID だけが違い、片方は BPM 解析済み・
 * 片方は未解析、という状態だった。おそらく同じ曲を 2 回読み込んだ跡。
 *
 * まとめないと何が起きるか:
 *   - analyzer は同じファイルを 2 回キューに積む（2 回目は done でスキップされるが無駄）
 *   - **--refresh-meta が永遠に「変更あり」を返し続ける**。2 つのエントリが交互に
 *     上書きし合うため（実際にこれで発覚した）
 *   - solver の xmlIndex も後勝ちで、どちらが採用されるか分からない
 *
 * 残す方（メタデータが充実している方）を選ぶ。BPM > キー > ジャンル の順に見て、
 * それでも決まらなければ TrackID の小さい方（**毎回同じ結果になることが重要**）。
 */
function dedupeByKey(tracks: XmlTrack[]): XmlTrack[] {
  const byKey = new Map<string, XmlTrack>();
  let dropped = 0;
  const score = (t: XmlTrack) => (t.xmlBpm ? 4 : 0) + (t.xmlKey ? 2 : 0) + (t.genre ? 1 : 0);
  for (const t of tracks) {
    const k = `${t.size}|${t.basename}`;
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, t); continue; }
    dropped++;
    const better = score(t) !== score(cur)
      ? (score(t) > score(cur) ? t : cur)
      : (String(t.trackId) < String(cur.trackId) ? t : cur);   // 同点なら安定した順で決める
    byKey.set(k, better);
  }
  if (dropped) console.log(`XML に同じファイルの二重登録が ${dropped} 件ありました。メタデータが充実している方を採用します`);
  return [...byKey.values()];
}

function applyRoot(p: string, opts: ParseOptions): string {
  if (!opts.audioRootFrom || !opts.audioRootTo) return p;
  const from = opts.audioRootFrom.replace(/\\/g, '/');
  const to = opts.audioRootTo.replace(/\\/g, '/');
  const norm = p.replace(/\\/g, '/');
  return norm.toLowerCase().startsWith(from.toLowerCase()) ? to + norm.slice(from.length) : p;
}
