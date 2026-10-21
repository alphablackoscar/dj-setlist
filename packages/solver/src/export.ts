// 出力。表（人が読む）/ rekordbox XML プレイリスト / M3U。
// XML と M3U は Windows で読む前提。Location は collection.xml の値をそのまま使う
// （Mac 側にその音源は存在しないので、パスを作り直してはいけない）。

import type { Bridge, SetEntry, SetlistCandidate } from './types.ts';

/** 表・XML・M3U に出す 1 行。つなぎの曲は曲番を持たない */
export type Item =
  | { kind: 'track'; entry: SetEntry }
  | { kind: 'bridge'; bridge: Bridge };

/**
 * **entries につなぎを織り込んで、かける順に並べる。**
 * つなぎは `afterPosition` の曲の直後に入る。出力はすべてこれを通すこと
 * （表と XML と M3U で順番が違う、という事故を構造で防ぐ）。
 */
export function walk(c: SetlistCandidate): Item[] {
  const out: Item[] = [];
  const after = new Map<number, Bridge[]>();
  for (const b of c.bridges ?? []) {
    if (!after.has(b.afterPosition)) after.set(b.afterPosition, []);
    after.get(b.afterPosition)!.push(b);
  }
  for (const e of c.entries) {
    out.push({ kind: 'track', entry: e });
    for (const b of after.get(e.position) ?? []) out.push({ kind: 'bridge', bridge: b });
  }
  return out;
}

/**
 * **セットの長さを曲の実長から出す。** 2026-10-17 追加。
 *
 * なぜ要るか（ユーザー報告）: 「13 曲 = 30 分」の換算しか出していなかったため、
 * 短い曲が並んだセットが**実際には 27 分で終わりそうになっていることに気づけなかった**。
 * 逆につなぎが入ると想定より長くなる。どちらも曲数からは見えない。
 *
 * 計算: **曲の実長 × 鳴らす割合**の合計。割合の根拠は config/venues.json の `set._comment`。
 * 中央値の長さ（4.00 分）の曲が並べば 2.31 分/曲の換算と一致する（13 曲 = 30.1 分）。
 *
 * **引き算（曲の長さ − 固定の重なり）にしない理由**: 2 分半の DJcity edit が
 * 「0.8 分しか鳴らない」という無意味な答えになる。抜けどころは曲の構成で決まるので、
 * 長い曲ほど長く鳴る割合の方が実態に近い（2026-10-17 に実測して気づいた）。
 */
export interface SetTiming {
  /** 1 曲の何割を鳴らすか（venues.json の set.played_fraction） */
  playedFraction: number;
  /** つなぎの曲の割合。BPM のランプを途中で切れないのでほぼ丸ごと鳴る */
  bridgePlayedFraction: number;
}
export function setMinutes(c: SetlistCandidate, t: SetTiming): {
  total: number; raw: number; played: number;
} {
  const items = walk(c);
  let raw = 0, total = 0;
  for (const it of items) {
    const d = (it.kind === 'track' ? it.entry.track.duration : it.bridge.track.duration) / 60;
    raw += d;
    total += d * (it.kind === 'bridge' ? t.bridgePlayedFraction : t.playedFraction);
  }
  return { total, raw, played: raw > 0 ? total / raw : 0 };
}

/** 全角を 2 幅として数える。日本語のタイトルで表が崩れないように */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}
function pad(s: string, n: number): string {
  let out = '', w = 0;
  for (const ch of s) {
    const cw = width(ch);
    if (w + cw > n) { out += '…'; w += 1; break; }
    out += ch; w += cw;
  }
  return out + ' '.repeat(Math.max(0, n - w));
}
function padL(s: string, n: number): string {
  return ' '.repeat(Math.max(0, n - width(s))) + s;
}

const bar = (v: number, n = 10): string => '█'.repeat(Math.round(v * n)) + '·'.repeat(n - Math.round(v * n));

export function formatTable(
  c: SetlistCandidate,
  targets: { groove: number[]; energy: number[] },
  /** 音の群れの id -> 表示名。無ければ id をそのまま出す */
  groupLabels?: Map<string, string>,
  /** 1 塊の目安曲数（config/weights.json の block.min）。表示のためだけに使う */
  blockLen: number = 3,
  /**
   * 1 曲あたりの実質の分（config/venues.json の set.minutes_per_track）。
   * **曲の長さの単純合計はセットの長さではない**（ミックスで重なるため）。
   * 持ち時間の見積りと同じ換算で出さないと、2 つの違う「合計」が並んで危ない。
   */
  minutesPerTrack: number = 2.31,
  /** 長いセットの塊。塊の 1 曲目の位置 -> 見出し。その行の上に区切りを入れる */
  blockHeads?: Map<number, string>,
  /**
   * 時間の計算に使う値（config/venues.json の set）。渡すと合計を**曲の実長から**出す。
   * 渡さないときは曲数 x minutesPerTrack の見込みだけを出す（古い呼び出しのため）。
   */
  timing?: SetTiming,
): string {
  const L: string[] = [];
  L.push('  #  ' + pad('曲名', 34) + pad('アーティスト', 20) + padL('原曲', 6) + padL('→', 6) + padL('ピッチ', 7) + '  key   ' +
         pad('エネルギー(目標)', 23) + pad('縦ノリ(目標)', 23) + 'フラグ');
  L.push('  ' + '─'.repeat(132));
  for (const it of walk(c)) {
    // つなぎの曲。**曲番を持たない別の層**なので、行の形も変えて曲と見間違えないようにする
    if (it.kind === 'bridge') {
      const b = it.bridge;
      const p = Math.abs(b.pitch) < 0.0005 ? '-' : `${b.pitch > 0 ? '+' : ''}${(b.pitch * 100).toFixed(1)}%`;
      L.push('  ⤴  ' + pad(`[つなぎ] ${b.track.title}`, 54) +
        padL(`${b.from}→${b.to}`, 12) + padL(`${b.effFrom.toFixed(1)}→${b.effTo.toFixed(1)}`, 14) +
        padL(p, 7) + '  ' + pad(b.track.camelot ?? '??', 6) + 'BRIDGE');
      continue;
    }
    const e = it.entry;
    const t = e.track;
    const i = e.position - 1;
    const head = blockHeads?.get(e.position);
    if (head) L.push(`  ── ${head} ` + '─'.repeat(Math.max(4, 100 - width(head))));
    const flags = [...new Set([...t.flags, ...e.flags])].join(' ');
    // 原曲の速度 → 実際にかける速度 → その差（ピッチ）。
    // 「この曲は +5.7% 上げて使う」が読み取れることが要点（2026-08-08 ユーザー指摘）。
    const natural = t.bpm * e.multiplier;
    const pitchTxt = Math.abs(e.pitch ?? 0) < 0.0005 ? '-'
      : `${e.pitch > 0 ? '+' : ''}${(e.pitch * 100).toFixed(1)}%${Math.abs(e.pitch) > 0.03 ? '!' : ''}`;
    L.push('  ' + padL(String(e.position), 2) + ' ' +
      pad(t.title, 34) + pad(t.artist, 20) +
      padL(natural.toFixed(1) + (e.multiplier === 1 ? '' : `x${e.multiplier}`), 6) +
      padL(e.effectiveBpm.toFixed(1), 6) + padL(pitchTxt, 7) + '  ' +
      pad(t.camelot ?? '??', 6) +
      pad(`${bar(t.energy)} ${t.energy.toFixed(2)}(${targets.energy[i].toFixed(2)})`, 23) +
      pad(`${bar(t.groove)} ${t.groove.toFixed(2)}(${targets.groove[i].toFixed(2)})`, 23) +
      flags);
  }
  // セットの性格。**音の群れ**が散らばっていないかを一目で見るため。
  // ジャンルのテキストではなく群で出すのは、テキストだと 34% が空欄で何も分からないため。
  const grpCount = new Map<string, number>();
  for (const e of c.entries) grpCount.set(e.track.soundGroup, (grpCount.get(e.track.soundGroup) ?? 0) + 1);
  const grpLine = [...grpCount.entries()].sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `${groupLabels?.get(g) ?? g} ${n}`).join(' / ');

  // 塊（ブロック）の並び。「2-3-3-2-3」のように出る。1 塊 3 曲が目安（config/weights.json の block）
  const runs: number[] = [];
  let lastCell: string | null = null;
  for (const e of c.entries) {
    if (lastCell !== null && e.track.soundCell === lastCell) runs[runs.length - 1]++;
    else runs.push(1);
    lastCell = e.track.soundCell;
  }

  // 持ち時間 -> 曲数と同じ換算の「見込み」。曲数を決めたときの数字なので必ず併記する
  const planMins = c.entries.length * minutesPerTrack;
  // **実際にかかる時間**（曲の実長 − 繋ぎ目の重なり）。これが本番で尽きるかどうかを決める
  const real = timing ? setMinutes(c, timing) : null;
  L.push('  ' + '─'.repeat(132));
  L.push(`  音の群れ: ${grpLine || '不明'}`);
  // 長いセットは塊（札）を見出しで出しているので、音の区画で数えた塊は出さない（別物なので紛らわしい）
  if (!blockHeads) L.push(`  塊: ${runs.join('-')}  （${runs.length} 塊。目安は 1 塊 ${blockLen} 曲）`);
  // ピッチをどれだけ使ったか。**寄せすぎていないかを 1 行で見る**
  const pitches = c.entries.map((e) => Math.abs(e.pitch ?? 0));
  const maxP = Math.max(0, ...pitches);
  const over = pitches.filter((p) => p > 0.03).length;
  if (maxP > 0.0005) {
    L.push(`  ピッチ: 最大 ±${(maxP * 100).toFixed(1)}%` +
      (over ? `   ±3% を超える曲 ${over} 曲（表の ! 印）` : '   全曲 ±3% 以内'));
  }
  const nb = (c.bridges ?? []).length;
  // **総再生時間を主役にする。** 曲数の換算は括弧に入れる（27 分で終わるのに 30 分と信じてしまうため）
  const timeTxt = real
    ? `合計 約 ${real.total.toFixed(0)} 分（曲の実長 ${real.raw.toFixed(0)} 分 の ${(real.played * 100).toFixed(0)}% を鳴らす見当` +
      `  /  持ち時間の換算では ${planMins.toFixed(0)} 分）`
    : `合計 ${planMins.toFixed(0)} 分（曲の長さの合計 ${(c.entries.reduce((a, e) => a + e.track.duration, 0) / 60).toFixed(0)} 分）`;
  L.push(`  ${c.entries.length} 曲${nb ? ` + つなぎ ${nb}` : ''}   ${timeTxt}`);
  L.push(`  cost ${c.totalCost.toFixed(2)}   要確認 ${c.manualChecks} 箇所   ` +
         `BPM ${Math.min(...c.entries.map((e) => e.effectiveBpm)).toFixed(0)}-${Math.max(...c.entries.map((e) => e.effectiveBpm)).toFixed(0)}`);
  return L.join('\n');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "C:/Users/x/a b.mp3" -> "file://localhost/C:/Users/x/a%20b.mp3" */
function toLocation(path: string): string {
  const p = path.replace(/\\/g, '/');
  const enc = p.split('/').map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');
  return 'file://localhost/' + enc.replace(/^\/+/, '');
}

/**
 * rekordbox に読ませる XML。COLLECTION に 13 曲だけ入れ、PLAYLISTS から TrackID で参照する。
 * rekordbox の「ファイル > 読み込み > コレクション XML」から取り込む。
 */
export function rekordboxXml(c: SetlistCandidate, name: string): string {
  const L: string[] = [];
  // つなぎの曲も**かける順のまま**プレイリストに入れる（入っていないと現場で探せない）
  const items = walk(c);
  const tracks = items.map((it) => it.kind === 'track' ? it.entry.track : it.bridge.track);
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<DJ_PLAYLISTS Version="1.0.0">');
  L.push('  <PRODUCT Name="dj-setlist" Version="0.1.0" Company="local"/>');
  L.push(`  <COLLECTION Entries="${tracks.length}">`);
  for (const t of tracks) {
    const a = [
      `TrackID="${xmlEscape(t.trackId ?? String(t.size))}"`,
      `Name="${xmlEscape(t.title)}"`,
      `Artist="${xmlEscape(t.artist)}"`,
      `Genre="${xmlEscape(t.genre)}"`,
      `Size="${t.size}"`,
      `TotalTime="${Math.round(t.duration)}"`,
      // 曲そのものの BPM を書く。倍率(x0.5/x2)を掛けた実効値ではない。
      // 実効値を書くと rekordbox 側のグリッドと食い違う。倍率は表と JSON に出してある
      `AverageBpm="${t.bpm.toFixed(2)}"`,
      t.camelot ? `Tonality="${xmlEscape(t.camelot)}"` : '',
      t.path ? `Location="${xmlEscape(toLocation(t.path))}"` : '',
    ].filter(Boolean).join(' ');
    L.push(`    <TRACK ${a}/>`);
  }
  L.push('  </COLLECTION>');
  L.push('  <PLAYLISTS>');
  L.push('    <NODE Type="0" Name="ROOT" Count="1">');
  L.push(`      <NODE Name="${xmlEscape(name)}" Type="1" KeyType="0" Entries="${tracks.length}">`);
  for (const t of tracks) L.push(`        <TRACK Key="${xmlEscape(t.trackId ?? String(t.size))}"/>`);
  L.push('      </NODE>');
  L.push('    </NODE>');
  L.push('  </PLAYLISTS>');
  L.push('</DJ_PLAYLISTS>');
  return L.join('\n') + '\n';
}

export function m3u(c: SetlistCandidate): string {
  const L = ['#EXTM3U'];
  for (const it of walk(c)) {
    const t = it.kind === 'track' ? it.entry.track : it.bridge.track;
    const mark = it.kind === 'bridge' ? '[つなぎ] ' : '';
    L.push(`#EXTINF:${Math.round(t.duration)},${mark}${t.artist} - ${t.title}`);
    // Windows のドライブレターならバックスラッシュに戻す
    L.push(t.path ? (/^[A-Za-z]:/.test(t.path) ? t.path.replace(/\//g, '\\') : t.path) : `# パス不明: ${t.basename}`);
  }
  return L.join('\n') + '\n';
}
