// Electron のメインプロセス。**ここは solver のロジックを一切持たない。**
//
// 設計上の約束（docs/DECISIONS.md）:
//   画面は solver を **子プロセスとして今の CLI をそのまま呼ぶ**。理由は 3 つ:
//     1. CLI と画面の挙動が絶対にずれない（同じものを呼んでいるので）
//     2. ビルド工程が増えない（solver は Node 24 が .ts をそのまま実行する。この長所を壊さない）
//     3. solver が落ちても画面は生き残る
//   3 案で 2.3 秒なので、プロセスを起動し直す分を足しても体感は変わらない。
//
// **Electron に同梱の Node ではなく、システムの Node を呼ぶ。**
// Electron 33 の Node は 20 系で TypeScript を直接実行できないため。
// Mac / Windows どちらにも Node 24 が入っていることは確認済み（.claude/CLAUDE.md 前提条件）。

const { app, BrowserWindow, ipcMain, shell, dialog, protocol } = require('electron');
// 配布版（.app）なら同梱の node / ffmpeg とデータの置き場所に切り替える。他の require より前に呼ぶ
const paths = require('./paths');
paths.setup(app);
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { countTracks } = require('./dbcount');
const { saveSetlist, listSetlists, loadSetlist, deleteSetlist } = require('./setlists');
const { getSettings, setMaxMinutes, configDir } = require('./settings');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'packages/solver/src/cli.ts');
// メモリーＱを打つ道具。**普通の書き出しとは別の経路**（ボタンを押したときだけ走る）
const CUE_CLI = path.join(ROOT, 'packages/cuetool/src/cli.js');

/**
 * **試聴で開いてよい音源のパス。** solver が返した曲だけを許す。
 * 画面から任意のファイルを読めてしまわないようにするための関門。
 */
const allowedAudio = new Set();

/** Chromium がそのまま鳴らせる形式。実データ: mp3 3676 / wav 102 / m4a 76 / aiff 90 */
const NATIVE = new Set(['.mp3', '.wav', '.m4a', '.mp4', '.ogg', '.flac']);

// 独自スキームは app.ready より前に宣言しないと登録できない
protocol.registerSchemesAsPrivileged([
  { scheme: 'djaudio', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true } },
]);

function runSolver(argv) {
  return new Promise((resolve) => {
    // **DB と XML と config は必ず明示して渡す。** CLI の既定任せにすると、画面が見ている
    // ものと solver が見るものがずれる（DJ_DB / DJ_CONFIG で差し替えたときに起きる）。
    // config を渡すのは、⚙ 設定 で変えた「持ち時間の上限」を solver も見るため。
    const child = spawn('node',
      [CLI, '--json', '--db', DB_PATH, '--xml', XML_DEST, '--config', configDir(), ...paths.outArgs(), ...argv],
      { cwd: ROOT, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({
      ok: false,
      error: e.code === 'ENOENT'
        ? 'node が見つかりません。「セットリストを作る.command」から起動してください。'
        : String(e.message),
      log: err,
    }));
    child.on('close', (code) => {
      if (!out.trim()) {
        // exit 2 = 組めなかった / 3 = 自己検査 NG。どちらも理由は標準エラー側にある
        return resolve({ ok: false, error: `solver が結果を返しませんでした（終了コード ${code}）`, log: err });
      }
      try {
        const data = JSON.parse(out);
        // 返ってきた曲の音源だけ試聴を許す
        for (const c of data.candidates ?? []) for (const e of c.entries ?? []) if (e.path) allowedAudio.add(e.path);
        for (const r of data.results ?? []) if (r.path) allowedAudio.add(r.path);
        resolve({ ok: true, data, log: err, exitCode: code });
      } catch (e) {
        resolve({ ok: false, error: '結果を読み取れませんでした: ' + e.message, log: err });
      }
    });
  });
}

ipcMain.handle('solve', (_e, argv) => runSolver(argv));

/**
 * 曲を探す。**画面の「締めに置きたい曲」はここから選ばせる。**
 * 打った文字列で 1 曲を黙って決めると、名前が似ているだけの別の曲を掴む（2026-08-08 の実害）。
 */
ipcMain.handle('find', (_e, argv) => runSolver(['--find', ...argv]));

/** その音源がこの機械にあるか。**Mac には音源が無いので試聴できない**（音源は Windows から出さない） */
ipcMain.handle('audio-ok', (_e, p) => {
  if (!p || !allowedAudio.has(p)) return { ok: false, why: 'この曲は試聴の対象ではありません' };
  try {
    fs.accessSync(p, fs.constants.R_OK);
  } catch {
    return { ok: false, why: 'この機械には音源がありません（音源は Windows にあります）' };
  }
  const ext = path.extname(p).toLowerCase();
  return { ok: true, native: NATIVE.has(ext), ext };
});

/**
 * **セットリストを書き出す。** out/ は実行のたびに増える作業場なので、
 * 残したいものだけここで名前を付けて別の場所へ保存する
 * （2026-08-08 ユーザー指摘:「どれが選ぶものか分からなくなる」）。
 */
/**
 * @param filePath  書き出す元のファイル（`out/` にあるもの）。拡張子で形式が決まる
 * @param suggested 保存ダイアログの既定の名前。**ここの拡張子が形式の正本**
 *
 * **形式を 2 つに分けている**（ユーザー指示 2026-10-21）:
 *   - 普通の書き出し = **`.m3u8`（rekordbox のプレイリスト）**。曲の並びとパスだけを渡す。
 *     **コレクション XML を渡すのをやめた。** XML には `AverageBpm` などの欄があり、
 *     取り込みのダイアログで「はい」を押すと**ロックしていない曲の拍位置とキーが
 *     上書きされうる**（2026-10-19 に実機で確認）。並びを渡すだけなら m3u8 で足り、
 *     レコボ側のデータに一切触らない。**この経路から上書きの危険が消えた。**
 *   - Ｑ付きの書き出し = `.xml`（POSITION_MARK を渡す欄が m3u8 に無いため。原理的に XML しかない）
 */
ipcMain.handle('export', async (_e, { filePath, suggested }) => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const isXml = /\.xml$/i.test(suggested ?? '');
  const r = await dialog.showSaveDialog(win, {
    title: isXml ? 'メモリーＱ付きで書き出す' : 'セットリストを書き出す',
    defaultPath: suggested,
    filters: isXml
      ? [{ name: 'rekordbox コレクション XML', extensions: ['xml'] }]
      : [{ name: 'rekordbox プレイリスト (m3u8)', extensions: ['m3u8'] }],
    properties: ['createDirectory'],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: '書き出すもとのファイルが見つかりません' };
    }
    fs.copyFileSync(filePath, r.filePath);
    return { ok: true, saved: r.filePath };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
});

/**
 * **メモリーＱを打った XML を作る。**「⬇ 書き出す」の横のボタンから呼ばれる。
 *
 * ユーザー指示 2026-10-17:「メモリキューは自動で打たず、書き出しの横にボタンをつけて」。
 * **普通の書き出しは今のまま**（Ｑを一切書かない）。この経路が壊れても普通の書き出しは無傷。
 *
 * 子プロセスで呼ぶ理由: cuetool は `node:sqlite` を使う。Electron 同梱の Node 20 には無い
 * （2026-10-03 にこれで「XML を読み込み」が毎回落ちていた。main で直接 require しないこと）。
 * ffmpeg で全長をデコードするので 1 曲 0.3 秒 = 26 曲で約 8 秒かかる。画面側で待つ。
 */
ipcMain.handle('cue-export', (_e, { xmlPath }) => new Promise((resolve) => {
  if (!xmlPath || !fs.existsSync(xmlPath)) {
    return resolve({ ok: false, error: 'もとのセットリスト XML が見つかりません' });
  }
  const child = spawn('node',
    [CUE_CLI, '--setlist', xmlPath, '--collection', XML_DEST, '--db', DB_PATH, '--json'],
    { cwd: ROOT, env: process.env });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => resolve({
    ok: false,
    error: e.code === 'ENOENT'
      ? 'node が見つかりません。「セットリストを作る.bat」から起動してください。'
      : String(e.message),
    log: err,
  }));
  child.on('close', (code) => {
    if (!out.trim()) return resolve({ ok: false, error: `Ｑを打てませんでした（終了コード ${code}）`, log: err });
    try { resolve({ ...JSON.parse(out), log: err }); }
    catch (e) { resolve({ ok: false, error: '結果を読み取れませんでした: ' + e.message, log: err }); }
  });
}));

// --- ⚙ 設定 -----------------------------------------------------------------
//
// いまのところ「持ち時間の上限」だけ。置き場所は config/venues.json
// （solver が読む唯一の場所。画面用に別ファイルを作ると上限が 2 つになる）。

ipcMain.handle('settings-get', () => {
  try { return { ok: true, ...getSettings() }; }
  catch (err) { console.error('[設定を読めません]', err.message); return { ok: false, error: err.message }; }
});

ipcMain.handle('settings-set-max-minutes', (_e, v) => {
  try { return { ok: true, ...setMaxMinutes(v) }; }
  catch (err) { console.error('[設定を変えられません]', err.message); return { ok: false, error: err.message }; }
});

// --- セトリ候補の保存と呼び出し ---------------------------------------------
//
// **保存したファイルはそのまま solver の --from に渡せる形にしてある**（setlists.js 参照）。
// だから呼び出したあとも「替える」「ここまで確定」「ここに挿入」が全部効く。
// 例外はここで文字列にして返す。画面に理由が出ないと直せない。

ipcMain.handle('setlist-save', (_e, arg) => {
  try { return { ok: true, ...saveSetlist(arg ?? {}) }; }
  catch (err) { console.error('[セトリを保存できません]', err.message); return { ok: false, error: err.message }; }
});

ipcMain.handle('setlist-list', () => {
  try { return { ok: true, items: listSetlists() }; }
  catch (err) { console.error('[セトリ一覧を読めません]', err.message); return { ok: false, error: err.message }; }
});

ipcMain.handle('setlist-load', (_e, id) => {
  try {
    const { data, file } = loadSetlist(String(id));
    // 呼び出した曲の試聴を許す（solve と同じ関門を通す）
    for (const c of data.candidates ?? []) for (const e of c.entries ?? []) if (e.path) allowedAudio.add(e.path);
    return { ok: true, data, file };
  } catch (err) { console.error('[セトリを呼び出せません]', err.message); return { ok: false, error: err.message }; }
});

ipcMain.handle('setlist-delete', (_e, id) => {
  try { return deleteSetlist(String(id)); }
  catch (err) { console.error('[セトリを消せません]', err.message); return { ok: false, error: err.message }; }
});

/** 書き出したファイルを Finder / エクスプローラで見せる */
ipcMain.handle('reveal', (_e, filePath) => { shell.showItemInFolder(filePath); });

// --- 曲を追加する ---------------------------------------------------------
//
// rekordbox で曲を足したあとの手順を画面 1 つにまとめる。**AI も手作業も要らない。**
// ここで判断が要らないのは、8/8 にジャンルのテキストを捨てて音の群れに切り替えたため。
// 未知のジャンル名が来ても canonical が空になるだけで、**音の群れは必ず付く**ので選曲から漏れない。
//
// 走らせるのは 3 つ。どれも「済んだ曲は飛ばす」ので、何度押しても増えた分しか時間がかからない。
//   1. --refresh-meta  あとから rekordbox でジャンルを埋めた分を DB に反映する（数秒）
//   2. 通常の解析      status='done' 以外だけ。1 曲 10.9 秒
//   3. --envelope      起伏を持っていない曲だけ。1 曲 0.5 秒

const ANALYZER = path.join(ROOT, 'packages/analyzer/src/index.ts');

// **置き場所をテストから差し替えられるようにしてある。**
// 既定は data/ 配下。DJ_XML / DJ_DB を渡すとそちらを使う。
// 「DB が無いとき」の挙動を、本物の features.db を壊さずに通しテストするために要る
// （2026-10-03。それまで DB 無しの経路は一度も確かめられていなかった）。
const XML_DEST = process.env.DJ_XML || path.join(ROOT, 'data/collection.xml');
const DB_PATH = process.env.DJ_DB || path.join(ROOT, 'data/features.db');

/** 実行中の子プロセス。「やめる」で殺すために持っておく */
let ingestChild = null;
let ingestCancelled = false;

ipcMain.handle('pick-xml', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, {
    title: 'rekordbox から書き出した XML を選んでください',
    filters: [{ name: 'rekordbox コレクション XML', extensions: ['xml'] }],
    properties: ['openFile'],
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

// **ここで node:sqlite を require してはいけない。**
// Electron 33 の Node は 20.18.3 で node:sqlite（Node 22.5 で追加）が無い。
// 直接開いていたせいで毎回例外になり、曲数が null のまま画面へ返っていた
// （2026-10-03。「XML を読み込み」が必ず最後に落ちる原因だった）。
// 数えるのはシステムの Node 24 に渡す。詳細は dbcount.js。
ipcMain.handle('db-count', async () => {
  try {
    return await countTracks(DB_PATH);
  } catch (err) {
    // **黙って null を返さない。** 返していたせいで黒い窓にも画面にも理由が出なかった
    console.error('[曲数が数えられません]', err.message);
    return null;
  }
});

/**
 * **まだ解析結果が無い状態を画面に伝える。**
 * features.db が無い機械（clone した直後や、DB をコミットしない運用）では
 * solver が必ず失敗する。そのとき画面が「読めませんでした」としか言わないと、
 * 何をすればよいか分からない。XML を読み込めば直ることを言えるようにする。
 * `exists:false` = DB が無い / `done:0` = DB はあるが 1 曲も解析されていない。
 */
ipcMain.handle('db-ready', async () => {
  if (!fs.existsSync(DB_PATH)) return { exists: false, done: 0, error: null };
  try {
    const c = await countTracks(DB_PATH);
    return { exists: true, done: c.done, error: null };
  } catch (err) {
    console.error('[曲数が数えられません]', err.message);
    return { exists: true, done: null, error: err.message };
  }
});

ipcMain.handle('ingest-cancel', () => {
  ingestCancelled = true;
  if (ingestChild) { try { ingestChild.kill(); } catch { /* 既に終わっている */ } }
});

/**
 * analyzer を 1 回走らせ、標準出力の行をそのまま画面へ流す。
 * 進捗は analyzer が出す `[3/26]` の形から拾う（analyzer 側に手を入れずに済む）。
 */
function runAnalyzer(args, phase, send) {
  return new Promise((resolve) => {
    ingestChild = spawn('node', [ANALYZER, '--xml', XML_DEST, '--db', DB_PATH, ...args],
      { cwd: ROOT, env: process.env });
    let rest = '', tailErr = '';
    const onLine = (line) => {
      if (!line.trim()) return;
      const m = /^\[(\d+)\/(\d+)\]/.exec(line);
      send({ phase, line, done: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null });
    };
    ingestChild.stdout.on('data', (d) => {
      rest += d.toString();
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const l of lines) onLine(l);
    });
    ingestChild.stderr.on('data', (d) => { tailErr += d.toString(); });
    ingestChild.on('error', (e) => { ingestChild = null; resolve({ ok: false, error: String(e.message) }); });
    ingestChild.on('close', (code) => {
      ingestChild = null;
      if (rest.trim()) onLine(rest);
      // ExperimentalWarning が常に出るので、失敗のときだけ標準エラーを見せる
      resolve(code === 0 ? { ok: true } : { ok: false, error: tailErr.trim().split(/\r?\n/).slice(-6).join('\n') || `終了コード ${code}` });
    });
  });
}

ipcMain.handle('ingest', async (e, xmlPath) => {
  const send = (msg) => { try { e.sender.send('ingest', msg); } catch { /* 画面が閉じた */ } };
  ingestCancelled = false;

  if (!fs.existsSync(xmlPath)) return { ok: false, error: 'その XML が見つかりません' };

  // **元の XML は残す。** 差し替えたあとに「前のに戻したい」が必ず起きる。
  // git にも入っているが、git を知らなくても戻せる方が良い。
  try {
    if (fs.existsSync(XML_DEST)) fs.copyFileSync(XML_DEST, XML_DEST + '.bak');
    if (path.resolve(xmlPath) !== path.resolve(XML_DEST)) fs.copyFileSync(xmlPath, XML_DEST);
  } catch (err) {
    return { ok: false, error: `XML を差し替えられませんでした: ${err.message}` };
  }
  send({ phase: 'copy', line: `XML を取り込みました: ${path.basename(xmlPath)}` });

  const steps = [
    { args: ['--refresh-meta'], phase: 'meta', label: '曲名やジャンルの更新' },
    { args: [], phase: 'analyze', label: '増えた曲の解析' },
    { args: ['--envelope'], phase: 'envelope', label: '曲の起伏' },
  ];
  for (const s of steps) {
    if (ingestCancelled) return { ok: false, cancelled: true };
    send({ phase: s.phase, line: `\n=== ${s.label} ===` });
    const r = await runAnalyzer(s.args, s.phase, send);
    if (ingestCancelled) return { ok: false, cancelled: true };
    if (!r.ok) return { ok: false, error: `${s.label}で止まりました:\n${r.error}` };
  }
  return { ok: true };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 860,
    title: 'セットリスト草案',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 画面側から Node を触らせない。solver の呼び出しはすべてメインプロセス経由にする
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // **画面側のエラーを黒い窓に出す。** 出さないと画面が黙って動かなくなり、原因が分からない
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['log', 'warn', 'error'][Math.min(2, Math.max(0, level - 1))] ?? 'log';
    console.log(`[画面:${tag}] ${message}` + (sourceId ? `  (${String(sourceId).split('/').pop()}:${line})` : ''));
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[画面が落ちました]', JSON.stringify(d)));
  win.webContents.on('unresponsive', () => console.error('[画面が応答しません]'));

  win.loadFile(path.join(__dirname, 'renderer/index.html'));
}

/**
 * 試聴用の配信口。`djaudio://play?p=<パス>&t=<開始秒>`
 *
 * **許可した曲以外は配らない。** 画面から任意のファイルを読めてしまわないようにするため。
 * mp3 / wav / m4a はそのまま流す（Range 対応。頭出しが速い）。
 * Chromium が鳴らせない形式（aiff など 90 曲）は ffmpeg で mp3 に変換しながら流す
 * （Windows には analyzer 用に ffmpeg が入っている）。
 */
function registerAudioProtocol() {
  protocol.handle('djaudio', async (req) => {
    const u = new URL(req.url);
    const file = u.searchParams.get('p') ?? '';
    const from = Number(u.searchParams.get('t') ?? 0);
    if (!allowedAudio.has(file)) return new Response('not allowed', { status: 403 });
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });

    const ext = path.extname(file).toLowerCase();
    if (!NATIVE.has(ext)) {
      // 変換しながら流す。頭出し位置から 90 秒あれば試聴には足りる
      const ff = spawn('ffmpeg', ['-ss', String(Math.max(0, from)), '-t', '90', '-i', file,
        '-f', 'mp3', '-b:a', '192k', '-loglevel', 'error', 'pipe:1']);
      let dead = false;
      ff.on('error', () => { dead = true; });   // ffmpeg が無ければ空で返る。画面が「鳴らせません」を出す
      const body = new ReadableStream({
        start(c) {
          ff.stdout.on('data', (d) => c.enqueue(new Uint8Array(d)));
          ff.stdout.on('end', () => { try { c.close(); } catch { /* 既に閉じている */ } });
          ff.stdout.on('error', () => { try { c.close(); } catch { /* 既に閉じている */ } });
          if (dead) { try { c.close(); } catch { /* 既に閉じている */ } }
        },
        cancel() { ff.kill('SIGKILL'); },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }

    // そのまま流す。Range に対応しておくと画面側の頭出しが一瞬で終わる
    const size = fs.statSync(file).size;
    const type = ext === '.wav' ? 'audio/wav' : ext === '.m4a' || ext === '.mp4' ? 'audio/mp4'
      : ext === '.ogg' ? 'audio/ogg' : ext === '.flac' ? 'audio/flac' : 'audio/mpeg';
    const range = req.headers.get('range');
    const m = range && /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    const stream = fs.createReadStream(file, { start, end });
    const body = new ReadableStream({
      start(c) {
        stream.on('data', (d) => c.enqueue(new Uint8Array(d)));
        stream.on('end', () => { try { c.close(); } catch { /* 既に閉じている */ } });
        stream.on('error', () => { try { c.close(); } catch { /* 既に閉じている */ } });
      },
      cancel() { stream.destroy(); },
    });
    return new Response(body, {
      status: m ? 206 : 200,
      headers: {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  });
}

app.whenReady().then(() => { registerAudioProtocol(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
