// 曲数を数える。**画面のプロセスでは features.db を開かない。**
//
// 2026-10-03 に判明した不具合の修正。main.js がここを
//   const { DatabaseSync } = require('node:sqlite');
// で直接やっていたが、**Electron 33 に同梱の Node は 20.18.3** で
// `node:sqlite`（Node 22.5 で追加）が存在しない。require が
// ERR_UNKNOWN_BUILTIN_MODULE を投げ、曲数が**毎回** null になっていた。
// その null を画面が素で参照していたため「XML を読み込み」が必ず最後に落ちた。
//
// solver / analyzer と同じ約束に合わせる: **DB に触る仕事はシステムの Node 24 に渡す。**
// 画面のプロセスからは子プロセス越しにしか DB を見ない。

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/db-count.js');

/**
 * `{ done, skipped, error }` を返す。数えられなければ **throw する**。
 * 黙って 0 や null を返さないこと（返していたせいで原因が見えなくなっていた）。
 */
function countTracks(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT, '--db', dbPath], { cwd: ROOT, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT'
      ? 'node が見つかりません。「セットリストを作る.bat」から起動してください。'
      : String(e.message))));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(err.trim().split(/\r?\n/).slice(-3).join(' / ') || `終了コード ${code}`));
      }
      let j;
      try { j = JSON.parse(out); } catch (e) { return reject(new Error('曲数を読み取れませんでした: ' + e.message)); }
      if (typeof j.done !== 'number' || typeof j.skipped !== 'number') {
        return reject(new Error('曲数の形が違います: ' + out.trim().slice(0, 120)));
      }
      resolve({ done: j.done, skipped: j.skipped, error: j.error ?? 0 });
    });
  });
}

module.exports = { countTracks };
