// セトリ候補の保存と呼び出し。
//
// **何のために要るのか（2026-10-03 ユーザー要望）。**
// 「後で持ち時間が増える」「このあと何曲か足したい」が実際に起きる。out/ は実行のたびに
// 増える作業場で 7 日で消えるので、**残したいものは別の場所に名前を付けて置く。**
//
// 保存するのは solver が返した結果 JSON そのもの + 名前など少しの情報。
// solver の `--from` は `candidates` と `request` を読むだけなので、
// **保存したファイルをそのまま `--from` に渡せる**（呼び出したあとも「替える」
// 「ここまで確定」「ここに挿入」が全部効く）。
// 書き出し用の XML / m3u8 だけは横にコピーする（out/ は 7 日で消えるため。下を見ること）。
//
// 置き場所は既定で `data/setlists/`（`data/*` は gitignore なので git には載らない）。
// テストは `DJ_SETLISTS` で差し替える。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

/** 保存先。テストから差し替えられるようにしてある */
function dir() {
  return process.env.DJ_SETLISTS || path.join(ROOT, 'data/setlists');
}

/**
 * **id は必ずこちらで作る。** 名前は日本語でも記号でも入るので、
 * それをファイル名に使うと符号化とパス区切りの事故が起きる。
 * 表示する名前は JSON の中に入れ、ファイル名は機械が作った安全な形だけにする。
 */
const ID_RE = /^set_[0-9]{8}_[0-9]{6}_[a-z0-9]{3}$/;

function newId(now, rand) {
  const p = (n, w) => String(n).padStart(w, '0');
  const d = `${now.getFullYear()}${p(now.getMonth() + 1, 2)}${p(now.getDate(), 2)}`;
  const t = `${p(now.getHours(), 2)}${p(now.getMinutes(), 2)}${p(now.getSeconds(), 2)}`;
  return `set_${d}_${t}_${rand}`;
}

function fileOf(id) {
  if (!ID_RE.test(String(id))) throw new Error(`保存の id が不正です: ${id}`);
  return path.join(dir(), `${id}.json`);
}

/** 名前の掃除。**空にはしない**（一覧で区別が付かなくなるため） */
function cleanName(name, fallback) {
  const s = String(name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

/**
 * 保存する。`payload` は solver が返した結果 JSON（画面が持っているもの）。
 * `ui` には画面の状態（見ている案・確定位置）を入れておく。
 */
function saveSetlist({ name, payload, ui }) {
  if (!payload || !Array.isArray(payload.candidates) || !payload.candidates.length) {
    throw new Error('保存できる結果がありません');
  }
  fs.mkdirSync(dir(), { recursive: true });
  const now = new Date();
  // 同じ秒に 2 回押しても別ファイルになるようにする
  let id = '', file = '';
  for (let i = 0; i < 40; i++) {
    id = newId(now, (Math.random().toString(36) + '000').slice(2, 5).replace(/[^a-z0-9]/g, '0'));
    file = path.join(dir(), `${id}.json`);
    if (!fs.existsSync(file)) break;
  }
  // **書き出し用の XML / m3u8 も横にコピーする。**
  // 案の files は out/ を指していて 7 日で消える。コピーしておかないと、呼び出したあと
  // 「書き出す」が失敗する（保存の意味が半分無くなる）。
  const cand0 = payload.candidates[0];
  const files = { ...(cand0.files ?? {}) };
  for (const [k, ext] of [['xml', '.xml'], ['m3u', '.m3u8']]) {
    const src = files[k];
    if (src && fs.existsSync(src)) {
      const dst = path.join(dir(), `${id}${ext}`);
      fs.copyFileSync(src, dst);
      files[k] = dst;
    }
  }

  const savedAt = now.toISOString();
  const data = {
    ...payload,
    // **保存するのは「いま見ている 1 案」だけ。** そうしておくと、このファイルを
    // そのまま `--from <file> --candidate 1` に渡せる（呼び出したあとも編集が効く）
    candidates: [{ ...cand0, files, _src: undefined }],
    savedName: cleanName(name, id),
    savedAt,
    ui: ui ?? null,
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return { id, name: data.savedName, savedAt, file };
}

/** 一覧。新しいものが先。壊れたファイルは飛ばす（1 つのせいで一覧が出ないと困る） */
function listSetlists() {
  const d = dir();
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    const m = /^(set_[0-9]{8}_[0-9]{6}_[a-z0-9]{3})\.json$/.exec(f);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      const idx = Number(j.ui?.candidateIndex ?? 0);
      const cand = j.candidates?.[idx] ?? j.candidates?.[0] ?? {};
      const entries = cand.entries ?? [];
      out.push({
        id: m[1],
        name: String(j.savedName ?? m[1]),
        savedAt: String(j.savedAt ?? ''),
        n: entries.length,
        // **総再生時間。** solver が出した値（曲の実長のうち実際に鳴らすぶん）を使う。
        // 曲の長さを単純に足すと 13 曲で 52 分と出て、実際の 30 分とかけ離れる。
        // 古い保存ファイルには minutes が無いので、そのときだけ単純合計に落ちる
        minutes: cand.minutes != null ? Math.round(Number(cand.minutes))
          : Math.round(entries.reduce((s, e) => s + (Number(e.duration) || 0), 0) / 60),
        venue: j.request?.venue ?? null,
        // 一覧で中身の見当が付くように、先頭の曲を 1 つだけ出す
        firstTitle: entries[0]?.title ?? '',
      });
    } catch { /* 壊れたファイルは一覧に出さない */ }
  }
  out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  return out;
}

/** 呼び出す。**ファイルのパスも返す**（そのまま solver の --from に渡すため） */
function loadSetlist(id) {
  const file = fileOf(id);
  if (!fs.existsSync(file)) throw new Error('その保存が見つかりません');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.candidates) || !data.candidates.length) {
    throw new Error('保存の中身が壊れています（案がありません）');
  }
  return { data, file };
}

function deleteSetlist(id) {
  const file = fileOf(id);
  if (!fs.existsSync(file)) return { ok: false, error: 'その保存が見つかりません' };
  fs.unlinkSync(file);
  // 横に置いた書き出し用のファイルも一緒に消す（残すと置き場所が散らかるだけ）
  for (const ext of ['.xml', '.m3u8']) {
    const f = path.join(dir(), `${id}${ext}`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  return { ok: true };
}

module.exports = { saveSetlist, listSetlists, loadSetlist, deleteSetlist, dir, ID_RE };
