// 画面を 1 枚撮る道具。**見た目を推敲するときに使う。**
//
//   cd packages/app
//   npm run shot -- --out ..\..\out\ui.png                   # 本物の data/ で
//   npm run shot -- --out ..\..\out\ui.png --minutes 120     # 曲が足りない状態を撮る
//   npm run shot -- --out ..\..\out\ui.png --test            # 100 曲のテスト用ライブラリで
//   npm run shot -- --out ..\..\out\ui.png --open-settings   # ⚙ 設定 を開いた状態で
//   npm run shot -- --out ..\..\out\ui.png --long --minutes 60   # 長いセット（ジャンルの塊）の画面
//   npm run shot -- --out ..\..\out\ui.png --no-go              # 作る前（入力欄だけ）の画面
//   npm run shot -- --out ..\..\out\ui.png --long --scroll       # 下まで送った状態
//   npm run shot -- --out ..\..\out\ui.png --wish mix             # 使いたい曲（「mix」で探して ✓ の 2 曲）を混ぜた結果
//   npm run shot -- --out ..\..\out\ui.png --wish mix --wish-open --no-go   # 曲を選ぶ重ね画面
//
// なぜ要るか（2026-10-03）: 画面の見た目は目で見ないと分からないが、毎回アプリを
// 起動して手で操作するのは面倒で、再現もしない。**同じ条件で撮り直せる**ようにしておく。
//
// `--test` を付けると本物の data/ と config/ に一切触らない
// （`out/test-import/` の資材が要る。無ければ SKIP）。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '../..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const OUT = path.resolve(process.cwd(), arg('out', path.join(ROOT, 'out/ui.png')));
const MINUTES = arg('minutes', null);
const useTest = has('test');

let TMP = null;
if (useTest) {
  const db = path.join(ROOT, 'out/test-import/work/features.db');
  const xml = path.join(ROOT, 'out/test-import/lib100.xml');
  if (!fs.existsSync(db) || !fs.existsSync(xml)) {
    console.log('SKIP: --test の資材がありません。先に:');
    console.log('  node scripts/make-test-xml.js --n 100');
    console.log('  node scripts/test-import.js');
    process.exit(0);
  }
  TMP = path.join(os.tmpdir(), 'dj-shot-' + process.pid);
  fs.mkdirSync(path.join(TMP, 'config'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'config'))) {
    fs.copyFileSync(path.join(ROOT, 'config', f), path.join(TMP, 'config', f));
  }
  process.env.DJ_DB = db;
  process.env.DJ_XML = xml;
  process.env.DJ_CONFIG = path.join(TMP, 'config');
  process.env.DJ_SETLISTS = path.join(TMP, 'sets');
}

const { app, BrowserWindow } = require('electron');
require('./main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = await new Promise((r) => {
    const t = setInterval(() => { const w = BrowserWindow.getAllWindows()[0]; if (w) { clearInterval(t); r(w); } }, 50);
  });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(2500);
  const X = (s) => win.webContents.executeJavaScript(s);

  // **長いセット（ジャンルの塊）の画面。** 既定の 13 曲とは出るものが別なので撮り分ける
  if (has('long')) {
    await X("(() => { const c = document.getElementById('longOn'); if (!c.checked) c.click(); return 1; })()");
    await wait(400);
  }
  if (MINUTES != null) {
    await X(`(() => { document.getElementById('minutes').value = ${JSON.stringify(String(MINUTES))}; return 1; })()`);
  }
  // 使いたい曲: 重ね画面で探して ✓ の曲を 2 曲選ぶ
  const wishQ = arg('wish', null);
  if (wishQ) {
    await X("document.getElementById('wishOpen').click()");
    await X(`(() => { document.getElementById('wishQ').value = ${JSON.stringify(wishQ)}; document.getElementById('wishFind').click(); return 1; })()`);
    for (let i = 0; i < 60 && !(await X("document.querySelectorAll('.wishhit').length")); i++) await wait(500);
    for (let k = 0; k < 2; k++) await X("(() => { const el = document.querySelector('.wishhit:not(.bad):not(.on)'); if (el) el.click(); return 1; })()");
    await wait(300);
    if (!has('wish-open')) await X("document.getElementById('wishDone').click()");
  }
  if (!has('no-go')) await X("document.getElementById('go').click()");
  for (let i = 0; i < 120 && (await X("document.getElementById('go').disabled")); i++) await wait(500);
  await wait(800);

  if (has('open-settings')) {
    await X("(() => { document.getElementById('settingsBox').open = true; return 1; })()");
    await wait(400);
  }
  if (has('scroll-saved')) {
    await X("(() => { document.getElementById('savedBox').scrollIntoView({ block: 'end' }); return 1; })()");
    await wait(400);
  }

  if (has('scroll')) {
    await X("(() => { window.scrollTo(0, document.body.scrollHeight); return 1; })()");
    await wait(400);
  }
  // 特定の行まで送って撮る（例: --scroll-to tr.bridge でつなぎの行）。
  // 表の途中にあるものは --scroll（最下部）でも写らないので、目印で指せるようにしてある
  const to = arg('scroll-to', null);
  if (to) {
    const found = await X(`(() => { const el = document.querySelector(${JSON.stringify(to)});
      if (!el) return 0; el.scrollIntoView({ block: 'center' }); return 1; })()`);
    if (!found) { console.error(`NG: "${to}" が画面にありません（撮るものが無い）`); app.exit(1); return; }
    await wait(400);
  }

  // **空の画像を黙って書かない。**（2026-10-17 に踏んだ: 0 バイトの PNG を書いて
  // 「撮りました」と言っていた。ウィンドウが他の窓に隠れている等で capturePage が
  // 空を返すことがあるため、取れるまで数回待ち、それでも空なら**落ちる**。
  // 失敗を 0 や null にして進めないのは main.js の db-count と同じ方針。）
  let png = null;
  for (let i = 0; i < 12; i++) {
    const img = await win.webContents.capturePage();
    if (!img.isEmpty()) { const b = img.toPNG(); if (b.length > 0) { png = b; break; } }
    if (i === 0) { win.show(); win.focus(); }   // 隠れているなら前に出す
    await wait(300);
  }
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  if (!png) {
    console.error('撮れませんでした: capturePage が空の画像を返し続けました（ウィンドウが隠れている / 画面がロックされている等）。');
    console.error('  0 バイトのファイルは書きません。前の画像が残っている場合はそれは古いものです。');
    app.exit(1);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, png);
  console.log(`撮りました: ${OUT}  (${(png.length / 1024).toFixed(0)} KB)`);
  app.quit();
});
