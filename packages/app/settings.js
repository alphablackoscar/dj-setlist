// 画面の ⚙ 設定。いまのところ「持ち時間の上限」だけ。
//
// **置き場所は config/venues.json（solver が読む唯一の場所）。**
// 画面用に別のファイルを作ると、画面と solver で違う上限を見ることになる。
// 2026-10-03 ユーザー要望:「120 分を既定の上限にして、設定画面で調節できるように。
// 6 時間の DJ をやる人もいる」。
//
// hard_max_minutes（既定 24 時間）は桁の打ち間違いを止める最後の関門で、
// 設定からも超えられない。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

/** 設定の置き場所。テストから差し替えられるようにしてある */
function configDir() {
  return process.env.DJ_CONFIG || path.join(ROOT, 'config');
}

function venuesPath() {
  return path.join(configDir(), 'venues.json');
}

function readVenues() {
  return JSON.parse(fs.readFileSync(venuesPath(), 'utf8'));
}

function getSettings() {
  const v = readVenues();
  const set = v.set ?? {};
  return {
    maxMinutes: Number(set.max_minutes ?? 120),
    minMinutes: Number(set.min_minutes ?? 1),
    hardMaxMinutes: Number(set.hard_max_minutes ?? 1440),
    minutesPerTrack: Number(set.minutes_per_track ?? 2.31),
  };
}

/** 持ち時間の上限を変える。**数字と範囲をここで必ず確かめる**（画面を信用しない） */
function setMaxMinutes(value) {
  const cur = getSettings();
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`上限は整数で指定してください（受け取った値: "${String(value)}"）`);
  if (n < cur.minMinutes) throw new Error(`上限は ${cur.minMinutes} 分以上にしてください（受け取った値: ${n}）`);
  if (n > cur.hardMaxMinutes) {
    throw new Error(`上限は ${cur.hardMaxMinutes} 分（${Math.round(cur.hardMaxMinutes / 60)} 時間）までです（受け取った値: ${n}）`);
  }
  const v = readVenues();
  v.set = { ...(v.set ?? {}), max_minutes: n };
  fs.writeFileSync(venuesPath(), JSON.stringify(v, null, 2) + '\n', 'utf8');
  return getSettings();
}

module.exports = { getSettings, setMaxMinutes, configDir };
