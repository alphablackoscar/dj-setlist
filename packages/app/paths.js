// 配布版（.app）のときだけ、node / ffmpeg / データの置き場所を差し替える。**開発中は何もしない。**
//
// これが Mac の配布の層と packages/app の唯一の接点（.claude/CLAUDE.md 役割分担 決まり 2）。
// 画面側のコードは `spawn('node' ...)` / `spawn('ffmpeg' ...)` と DJ_* の環境変数のままでよい:
//   - PATH の先頭に .app 同梱の bin/ を足すので、'node' / 'ffmpeg' / 'ffprobe' は同梱物に当たる
//     （利用者の Mac に Node も ffmpeg も入っていない前提。子プロセスにも PATH が引き継がれる）
//   - DJ_DB / DJ_XML / DJ_CONFIG / DJ_SETLISTS / DJ_OUT を ~/Library/Application Support/<app>/ に向ける
//     （.app の中は書き込めない。書くと署名も壊れる）
// 環境変数が既に入っていれば触らない（テストが差し替えに使っているため）。
//
// **main.js の一番上、他の require より前に呼ぶこと。** main.js は読み込み時に DJ_DB などを読む。

const path = require('node:path');
const fs = require('node:fs');

/** ⚙ 設定 が書き換える唯一の設定ファイル（settings.js） */
const USER_EDITED = 'venues.json';

function setup(app) {
  if (!app.isPackaged) return { packaged: false };

  const res = process.resourcesPath;
  process.env.PATH = path.join(res, 'bin') + path.delimiter + (process.env.PATH ?? '');

  const ud = app.getPath('userData');
  const def = {
    DJ_DB: path.join(ud, 'features.db'),
    DJ_XML: path.join(ud, 'collection.xml'),
    DJ_CONFIG: path.join(ud, 'config'),
    DJ_SETLISTS: path.join(ud, 'setlists'),
    DJ_OUT: path.join(ud, 'out'),
  };
  for (const [k, v] of Object.entries(def)) if (!process.env[k]) process.env[k] = v;
  fs.mkdirSync(process.env.DJ_SETLISTS, { recursive: true });
  fs.mkdirSync(process.env.DJ_OUT, { recursive: true });

  // 設定は .app に同梱した config/ を起動のたびに写す（新しい版の重みや札を届けるため）。
  // **例外は ⚙ 設定 が書く venues.json だけ** — 無いときだけ写す（利用者が変えた値を消さない）
  const src = path.join(res, 'app', 'config');
  fs.mkdirSync(process.env.DJ_CONFIG, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const dst = path.join(process.env.DJ_CONFIG, f);
    if (f === USER_EDITED && fs.existsSync(dst)) continue;
    fs.copyFileSync(path.join(src, f), dst);
  }
  return { packaged: true, userData: ud };
}

/** solver に渡す出力先。開発中は CLI の既定（repo の out/）のまま */
const outArgs = () => (process.env.DJ_OUT ? ['--out', process.env.DJ_OUT] : []);

module.exports = { setup, outArgs };
