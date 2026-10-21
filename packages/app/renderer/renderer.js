// 画面側。**solver のロジックはここに一切書かない。** すべて window.dj 経由で CLI を呼ぶ。
//
// 主役の操作は「行のボタン」であって設定のつまみではない。DJ が実際にやるのは頭から順に
// 固めていくことなので、そこを一番押しやすい場所に置く:
//   ここまで確定 = --drop（その行より下だけを 3 案作り直す。上は動かない）
//   この曲を替える = --swap（前後は動かさない）

// **どこで落ちても画面に出す。** 黙って動かなくなるのが一番困る（原因が分からない）
function showFatal(where, e) {
  const msg = (e && (e.stack || e.message)) || String(e);
  const box = document.getElementById('sheet');
  if (box) box.innerHTML = `<div class="err">画面でエラーが起きました（${where}）\n\n${String(msg).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`;
  console.error('[fatal]', where, msg);
}
window.addEventListener('error', (ev) => showFatal('読み込み/実行', ev.error ?? ev.message));
window.addEventListener('unhandledrejection', (ev) => showFatal('非同期処理', ev.reason));

/** 秒 -> 03:20。**曲の長さは分秒でないと使い物にならない**（何分のセットかを頭で足すため） */
const mmss = (sec) => {
  const s = Math.round(Number(sec) || 0);
  if (!(s > 0)) return '—';
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`画面の部品 "${id}" がありません（index.html と renderer.js がずれています）`);
  return el;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tail = (s, n = 2000) => String(s ?? '').slice(-n);

/** 直近の結果。--drop / --swap は前の結果 JSON を指して呼ぶ */
let last = null;
let tabIndex = 0;
/** 締めに選んだ曲。曲名を打たせるのではなく、候補から選ばせる */
let anchor = null;
/** 使いたい曲 [{basename, title, artist, bpm, camelot}]。「作る」のたびに solver が混ぜる */
let wishes = [];
const WISH_MAX = 5;

// --- 置き換えた曲の履歴 ---
//
// **2026-10-21 ユーザー要求**: 「『曲を変更』で曲を変えてから『さっきの曲のほうが良かったな』
// と思うことがある」。外した曲を覚えておき、聴いてから戻せるようにする。
//
// 鍵は **`案の番号:位置`**（案ごとに別の履歴。同じ位置でも案 A と案 B は別物）。
// 新しいものが後ろ。**曲の実体をそのまま持つ**（試聴に `path` と `windowStart` が要るため、
// 題名だけ覚えても戻せない / 聴けない）。
const swapHistory = new Map();
const histKey = (pos) => `${tabIndex}:${pos}`;
const historyOf = (pos) => swapHistory.get(histKey(pos)) ?? [];
function pushHistory(pos, entry) {
  if (!entry) return;
  const k = histKey(pos);
  const a = swapHistory.get(k) ?? [];
  // 同じ曲を 2 回積まない（戻す → また差し替える を繰り返したとき）
  if (a.some((x) => x.basename === entry.basename)) return;
  a.push({ ...entry, at: new Date().toLocaleTimeString('ja-JP') });
  swapHistory.set(k, a);
}
/**
 * **曲を足したら履歴の位置もずらす。** position は差し替え・保存・自己検査の鍵なので、
 * 挿入で番号が動くと履歴が 1 つ手前の行にぶら下がる（過去に同種の事故を踏んでいる）。
 */
function shiftHistory(at) {
  const moved = [];
  for (const [k, v] of swapHistory) {
    const [ti, p] = k.split(':');
    if (Number(ti) !== tabIndex || Number(p) < at) continue;
    moved.push([k, `${ti}:${Number(p) + 1}`, v]);
  }
  for (const [k] of moved) swapHistory.delete(k);
  for (const [, nk, v] of moved) swapHistory.set(nk, v);
}
/** 土台から作り直したら履歴は意味を失う（別の曲が並ぶため）。黙って残さない */
const clearHistory = () => swapHistory.clear();

// --- 浅い時間 ---
// 講師の指摘:「ビルドアップが強い曲はうるさすぎてカフェ利用の人が話せない」。
// 実測（2026-08-08）: NG と言われた `F_Happier - KENTO Remix` は g1、OK の `stand high` は g8。
// **音の細部では割れなかった**（ドロップの落差 7.2dB 対 7.9dB でむしろ逆）。
// 曲の性格の違いなので、音の群れで外すのが正解だった。
const EARLY_EXCLUDE = 'g1';
/** 群の id 一覧。loadGroups() が実データで埋める（番号と中身の対応は作り直すと変わる） */
let allGroupIds = [];

// 行に出る印。**英語の内部名をそのまま見せない。**（2026-10-17）
// 何の印かと、それを見て何をすればよいかが 1 行で分かる形にする。
const FLAG_TEXT = {
  KEY_CHECK:    ['key 要確認', 'rekordbox のキーと解析結果が食い違う曲。前後と繋ぐ前に耳で確かめる'],
  MANUAL_CHECK: ['繋ぎ 要確認', '前の曲とキーが離れている。ミックスの仕方で対処する'],
  BPM_CHECK:    ['BPM 要確認', 'rekordbox の BPM と解析結果が離れている曲'],
  BPM_LOW_CONF: ['BPM 自信なし', '解析が BPM を決めきれなかった曲。かける前に確かめる'],
  CUT:          ['✂ カット', 'ここは繋がずに切り替える（BPM が離れているため）'],
  BRIDGED:      ['つなぎで接続', 'BPM は離れているが、直前のつなぎの曲が繋いでいる。カットしなくてよい'],
};

// --- 長いセット（1-2 時間）---
// ジャンル札（config/cards.json）の塊を並べる。札の一覧は loadGroups() の空解きで受け取る。
/** 札の一覧 [{id, label, level, default_on, anime}] */
let cardList = [];
/** 鍵をかけた塊（0 始まり）。「全部選び直す」「札を外す」でも触らない。新しく「作る」と外れる */
let blockLocks = new Set();
const isLong = () => $('longOn').checked;

// --- 試聴 ---
// **Windows でしか鳴らない**（音源は Windows から出さない約束）。Mac ではその旨を出す。
// 頭出しは解析が「その曲らしい」と判断した位置から。イントロからでは曲の性格が分からない。
const player = new Audio();
let playingKey = null;
player.addEventListener('error', () => {
  $('msg').textContent = '試聴できませんでした（この形式は鳴らせないか、ファイルが読めません）';
  stopPreview();
});

function stopPreview() {
  player.pause();
  player.removeAttribute('src');
  player.load();
  playingKey = null;
  for (const b of document.querySelectorAll('.play')) { b.classList.remove('on'); b.textContent = '▶'; }
}

async function togglePreview(e, btn) {
  const key = e.basename;
  if (playingKey === key) { stopPreview(); return; }
  stopPreview();
  const chk = await window.dj.audioOk(e.path);
  if (!chk.ok) { $('msg').textContent = chk.why; return; }
  const from = Math.max(0, Math.round(e.windowStart ?? 0));
  player.src = `djaudio://play?p=${encodeURIComponent(e.path)}&t=${from}`;
  // そのまま鳴らせる形式は自分で頭出しする。変換して流す形式は既に頭出し済みで届く
  player.currentTime = 0;
  const seek = () => { if (chk.native) { try { player.currentTime = from; } catch { /* 頭出しできなくても鳴らす */ } } };
  player.addEventListener('loadedmetadata', seek, { once: true });
  try {
    await player.play();
    playingKey = key;
    btn.classList.add('on'); btn.textContent = '■';
    $('msg').textContent = `試聴中: ${e.title}（${from} 秒あたりから）`;
  } catch (err) {
    $('msg').textContent = '試聴を始められませんでした: ' + (err?.message ?? err);
  }
}

async function call(argv, what) {
  $('go').disabled = true;
  $('msg').textContent = what + '…';
  const t0 = performance.now();
  const r = await window.dj.solve(argv);
  $('go').disabled = false;
  if (!r.ok) {
    $('sheet').innerHTML = `<div class="err">${esc(r.error)}\n\n${esc(tail(r.log))}</div>`;
    $('msg').textContent = '失敗しました';
    return null;
  }
  const notes = (r.data.notes ?? []).length ? '  ※ ' + r.data.notes.join(' / ') : '';
  $('msg').textContent = `${what}: ${Math.round(performance.now() - t0)}ms / ${r.data.candidates.length} 案 / 候補 ${r.data.poolSize} 曲${notes}`
    + (r.data.shortfall ? `　★ 曲が足りません（${r.data.shortfall.gotTracks} / ${r.data.shortfall.askedTracks} 曲）` : '')
    + (r.exitCode === 3 ? '  ※ 自己検査 NG（solver のバグ。ログを確認してください）' : '');
  return r.data;
}

/**
 * セットの BPM。**既定はおまかせ。**
 * ユーザー指摘（2026-08-08）:「BPM を支配的に指定してやるケースは少ない。
 * 最後の曲を指定すれば一意に決まるし、pops おまかせなら 128 でも 126 でも大差ない」
 * おまかせのときは solver 側が決める（締めの曲 → その BPM / 無ければ候補の中央値）。
 */
function setBpmArg() {
  if ($('bpmMode').value === 'auto') return 'auto';
  const b1 = Number($('bpm1').value) || 128;
  if (!$('phaseOn').checked) return String(b1);
  const b2 = Number($('bpm2').value) || b1;
  const at = Math.max(2, Number($('phaseAt').value) || 7);
  return `${b1}:1,${b2}:${at}`;
}

/** 左の欄からフラグを組み立てる。withAnchor=false なら締めの指定を外す（検索のとき用） */
function orderArgv(extra = [], withAnchor = true) {
  const a = [];
  if (isLong()) {
    // 長いセットは「持ち時間」と「今日使ってよいジャンル」だけ。BPM・箱・群は塊ごとに決まる
    a.push('--long', '--minutes', String(Number($('minutes').value) || 60));
    const cs = [...document.querySelectorAll('#cards input:checked')].map((x) => x.value);
    if (cs.length) a.push('--cards', cs.join(','));
    if (withAnchor && anchor) a.push('--anchor', anchor.basename);
    if (withAnchor && wishes.length) a.push('--wish', wishes.map((w) => w.basename).join('|'));
    return a.concat(extra);
  }
  const venue = $('venue').value;
  if (venue) a.push('--venue', venue);
  // **黙って 30 分に化けさせない。** 以前は `Number(値) || 30` だったので、0 や空や
  // 打ち間違いが 30 分になっていた。そのまま渡して solver に断らせる（理由が出る）
  a.push('--minutes', $('minutes').value.trim() === '' ? 'なし' : $('minutes').value.trim());
  a.push('--set-bpm', setBpmArg());
  a.push('--anime', $('anime').value);
  // **浅い時間は「派手めの EDM(g1) を外す」で表現する。**
  // 講師が NG と言った曲は g1、OK と言った曲は g8 だった（2026-08-08 実測）。
  // 音の細部（ドロップの落差）では 7.2dB 対 7.9dB でむしろ逆になり、区別できなかった。
  const slot = $('slot').value;
  const gs = [...document.querySelectorAll('#groups input:checked')].map((x) => x.value);
  // 群を選んでいなければ「g1 以外の全部」、選んでいればそこから g1 を抜く（併用できる）
  const picked = slot.startsWith('early')
    ? (gs.length ? gs : allGroupIds).filter((g) => g !== EARLY_EXCLUDE)
    : gs;
  if (picked.length) a.push('--groups', picked.join(','));
  // 落差でも抑えたいとき。効き方は弱いので既定では使わない
  if (slot === 'early_calm') a.push('--calm');
  // **曲名の文字列ではなく、選んだ曲のファイル名を渡す。** 別の曲を掴む事故を防ぐ
  if (withAnchor && anchor) a.push('--anchor', anchor.basename);
  // 区切りは | （Windows のファイル名に使えない文字なので、ファイル名と衝突しない）
  if (withAnchor && wishes.length) a.push('--wish', wishes.map((w) => w.basename).join('|'));
  const only = $('only').value.trim();
  if (only) a.push('--only', only);
  return a.concat(extra);
}

// --- 曲を探す ---
// 打った文字列で 1 曲を黙って決めない。**候補を出して選ばせる。**
// 「girl friend」で別の曲（BPM 85）を掴んで組めなくなった実害があったため。
async function doFind() {
  const q = $('anchorQ').value.trim();
  if (!q) return;
  $('hits').innerHTML = '<span class="dim">探しています…</span>';
  // 締めの指定は外して呼ぶ（今の締めではなく、これから選ぶ候補を探すため）
  const r = await window.dj.find([q, ...orderArgv([], false)]);
  if (!r.ok) { $('hits').innerHTML = `<span class="dim">探せませんでした</span>`; return; }
  const rows = r.data.results ?? [];
  if (!rows.length) { $('hits').innerHTML = '<span class="dim">見つかりませんでした</span>'; return; }
  $('hits').innerHTML = rows.map((x, i) => `
    <div class="hit ${x.usable ? '' : 'bad'}" data-i="${i}">
      <span class="ok">${x.usable ? '✓' : '×'}</span>
      <button class="play" data-playhit="${i}" title="試聴（曲の聞かせどころから）">▶</button>
      <span class="b">${x.bpm.toFixed(1)}</span>
      <span class="b">${esc(x.camelot ?? '??')}</span>
      <span class="t">${esc(x.title)} <span class="dim">${esc(x.artist)}</span></span>
    </div>`).join('');
  // **`#hits` の中だけを配線する。** `.hit` で拾うと「使いたい曲」の候補まで掴んで
  // `data-i` が無い行で pickAnchor(undefined) になり、画面が落ちる（2026-10-21 に発見）
  for (const el of document.querySelectorAll('#hits .hit')) {
    el.onclick = (ev) => {
      if (ev.target.closest('.play')) return;        // ▶ は選択ではない
      pickAnchor(rows[Number(el.dataset.i)]);
    };
  }
  wirePlayHits('#hits', rows);
}

/**
 * 探した候補の ▶ を配線する。**どの曲を選んでいるのか耳で確かめられないと、
 * 同じ曲の別のリミックスを選んでしまう**（2026-10-21 ユーザー報告。happier で実際に起きた）。
 */
function wirePlayHits(scope, rows) {
  for (const b of document.querySelectorAll(`${scope} [data-playhit]`)) {
    b.onclick = guard('試聴', async (ev) => {
      ev.stopPropagation();
      const x = rows[Number(b.dataset.playhit)];
      if (!x) return;
      // **path が無ければ鳴らせない。** 黙って無反応にせず理由を出す
      if (!x.path) { $('msg').textContent = 'この曲は音源の場所が分かりません（解析し直すと試聴できます）'; return; }
      await togglePreview(x, b);
    });
  }
}

/** 締めの曲を確定する。**使えるかどうかを、作る前にここで言う。** */
function pickAnchor(x) {
  anchor = x;
  $('hits').innerHTML = '';
  const box = $('anchorPick');
  box.classList.remove('hidden');
  if (x.usable && x.autoBpm != null) {
    // おまかせ: **セットの BPM をこの曲に合わせる**ので、締めはピッチ 0 でかけられる
    box.className = '';
    box.innerHTML = `締め: <b>${esc(x.title)}</b> / ${esc(x.artist)}<br>
      セットの BPM はこの曲に合わせます（<b>${x.autoBpm}</b>）。締めはピッチ 0 でかかります
      　<a href="#" id="clearAnchor">外す</a>`;
  } else if (x.usable) {
    const p = x.pitch != null ? `${x.pitch > 0 ? '+' : ''}${(x.pitch * 100).toFixed(1)}%` : '';
    box.className = '';
    box.innerHTML = `締め: <b>${esc(x.title)}</b> / ${esc(x.artist)}<br>
      原曲 ${x.bpm.toFixed(1)} → セット ${x.setBpm ?? '-'} （${p}）  <a href="#" id="clearAnchor">外す</a>`;
  } else {
    box.className = 'warn';
    box.innerHTML = `⚠ <b>${esc(x.title)}</b> は原曲 ${x.bpm.toFixed(1)} BPM で、` +
      (x.autoBpm != null
        ? ` この箱の BPM 帯から外れています。<br>箱を変えるか、別の曲を選んでください。`
        : ` いま指定したセットの BPM に ±5% では届きません。<br>
           セットの BPM を ${Math.round(x.bpm)} 前後にするか、別の曲を選んでください。`) +
      ` <a href="#" id="clearAnchor">外す</a>`;
  }
  $('clearAnchor').onclick = (e) => {
    e.preventDefault(); anchor = null; box.classList.add('hidden'); box.innerHTML = '';
  };
}

// --- 使いたい曲 ---
// 探し方は締めの曲と同じ（--find）。**打った文字列で黙って決めず、候補から選ばせる。**
// 混ぜるかどうか・どこに入れるかは solver が決める（画面に選曲のロジックを持たない約束）。
let wishRows = [];
function renderWishList() {
  $('wishList').innerHTML = wishes.map((w, i) => `
    <div class="wishchip"><span class="t">${esc(w.title)} <span class="dim">${esc(w.artist)}</span></span>
      <span class="dim">${w.bpm.toFixed(1)}</span><a href="#" data-unwish="${i}" title="外す">✕</a></div>`).join('');
  for (const a of document.querySelectorAll('[data-unwish]')) {
    a.onclick = (e) => { e.preventDefault(); wishes.splice(Number(a.dataset.unwish), 1); renderWishList(); renderWishHits(); };
  }
  $('wishPicked').textContent = wishes.length ? `選んだ曲: ${wishes.length} / ${WISH_MAX}` : 'まだ選んでいません';
}
function renderWishHits() {
  const on = new Set(wishes.map((w) => w.basename));
  // **▶ を置く。** 同じ曲のリミックスが何本もあるので、聴かずに選ぶと別の版を掴む
  // （2026-10-21 ユーザー報告: happier で指定したリミックスと違うものが使われた）。
  // 曲名も**基になったファイル名まで**出す（"Happier - KENTO Remix" が 2 ファイルある）
  $('wishHits').innerHTML = wishRows.map((x, i) => `
    <div class="hit wishhit ${x.usable ? '' : 'bad'} ${on.has(x.basename) ? 'on' : ''}" data-w="${i}">
      <span class="ok">${on.has(x.basename) ? '★' : x.usable ? '✓' : '×'}</span>
      <button class="play" data-playhit="${i}" title="試聴（曲の聞かせどころから）">▶</button>
      <span class="b">${x.bpm.toFixed(1)}</span>
      <span class="b">${esc(x.camelot ?? '??')}</span>
      <span class="t">${esc(x.title)} <span class="dim">${esc(x.artist)}</span>
        <div class="dim" style="font-size:10px">${esc(x.basename)}</div></span>
    </div>`).join('');
  wirePlayHits('#wishHits', wishRows);
  for (const el of document.querySelectorAll('.wishhit')) {
    el.onclick = (ev) => {
      if (ev.target.closest('.play')) return;        // ▶ は選択ではない
      const x = wishRows[Number(el.dataset.w)];
      const k = wishes.findIndex((w) => w.basename === x.basename);
      if (k >= 0) wishes.splice(k, 1);
      else if (wishes.length >= WISH_MAX) { $('wishPicked').textContent = `選べるのは ${WISH_MAX} 曲までです`; return; }
      else wishes.push({ basename: x.basename, title: x.title, artist: x.artist, bpm: x.bpm, camelot: x.camelot });
      renderWishList(); renderWishHits();
    };
  }
}
async function doWishFind() {
  const q = $('wishQ').value.trim();
  if (!q) return;
  $('wishHits').innerHTML = '<span class="dim">探しています…</span>';
  const r = await window.dj.find([q, ...orderArgv([], false)]);
  if (!r.ok) { $('wishHits').innerHTML = '<span class="dim">探せませんでした</span>'; return; }
  wishRows = r.data.results ?? [];
  if (!wishRows.length) { $('wishHits').innerHTML = '<span class="dim">見つかりませんでした（今の設定で使える曲の中にありません）</span>'; return; }
  renderWishHits();
}

/** 案ごとの「使いたい曲がどうなったか」。入らなかった曲は理由を必ず出す */
function wishHtml(c) {
  if (!c.wishes?.length) return '';
  const lines = c.wishes.map((w) => w.position != null
    ? `<div>★ <b>${esc(w.title)}</b> → ${w.position} 曲目` +
      (w.replaced ? ` <span class="dim">（「${esc(w.replaced.title)}」と入れ替え）</span>` : ' <span class="dim">（もともと入っていました）</span>') + `</div>`
    : `<div class="no">× <b>${esc(w.title)}</b> は入れませんでした — ${esc(w.reason ?? '')}</div>`);
  const ok = c.wishes.filter((w) => w.position != null).length;
  return `<div class="banner wishrep">使いたい曲: ${ok} / ${c.wishes.length} 曲を入れました${lines.join('')}</div>`;
}

// --- 群の一覧。空解きを 1 回して soundGroups をもらう ---
async function loadGroups() {
  const r = await window.dj.solve(['--venue', 'edm', '--n', '2']);
  const box = $('groups');
  if (!r.ok) { box.innerHTML = `<span style="color:#ff8f8f">読めませんでした</span>`; return; }
  box.innerHTML = r.data.soundGroups.map((g) => `
    <label><input type="checkbox" value="${g.id}"><span>${esc(g.label)}</span><span class="n">${g.count}</span></label>
  `).join('');
  // 「浅い時間」で外す群の名前を、決め打ちせず実際のラベルから引いて出す。
  // 群を作り直すと番号と中身の対応が変わるため（session-state の Do not に明記されている）
  allGroupIds = r.data.soundGroups.map((g) => g.id);
  cardList = r.data.cards ?? [];
  renderCards();
  const ex = r.data.soundGroups.find((g) => g.id === EARLY_EXCLUDE);
  if (ex) $('slotHint').textContent = `まだ客が話している時間帯は「${ex.label}」(${ex.count}曲)を外します`;
}

// --- 描画 ---
function render() {
  if (!last) return;
  $('tabs').innerHTML = last.candidates.map((c, i) =>
    `<button class="tab ${i === tabIndex ? 'on' : ''}" data-i="${i}">案 ${String.fromCharCode(65 + i)}` +
    `<span style="color:var(--dim);font-weight:400"> ・要確認 ${c.manualChecks}</span></button>`).join('');
  for (const b of document.querySelectorAll('.tab')) b.onclick = () => { tabIndex = Number(b.dataset.i); render(); };

  const c = last.candidates[tabIndex];
  if (!c) { $('sheet').innerHTML = '<div class="empty">案がありません</div>'; return; }

  const lockedUntil = last.lockedUntil ?? 0;
  const comfort = last.pitchComfort ?? 0.03;
  let lastSetBpm = null;
  const blocks = last.blocks ?? null;
  const blockStart = new Map((blocks ?? []).map((b) => [b.start, b]));

  const wishSet = new Set(wishes.map((w) => w.basename));
  const rows = c.entries.map((e) => {
    const locked = e.position <= lockedUntil;
    const flags = e.flags.filter((f) => f !== 'KEY_MISSING')
      .map((f) => { const d = FLAG_TEXT[f]; return `<span class="flag" title="${esc(d ? d[1] : f)}">${esc(d ? d[0] : f)}</span>`; }).join('');
    const hot = Math.abs(e.pitch ?? 0) > comfort;
    const pitchTxt = Math.abs(e.pitch ?? 0) < 0.0005 ? '—'
      : `${e.pitch > 0 ? '+' : ''}${(e.pitch * 100).toFixed(1)}%`;
    // セットの BPM が変わる位置に線を入れる。**どこで変わるかが見えることが要点**
    const bpmChanged = !blocks && lastSetBpm != null && Math.abs(e.bpm - lastSetBpm) > 0.05;
    lastSetBpm = e.bpm;
    const bh = blockStart.get(e.position);
    const dividers =
      (bh ? `<tr class="blockhead"><td colspan="9">${bh.index + 1}. ${esc(bh.label)}　${bh.n} 曲　${bh.bpm} BPM` +
        // ✂ の所につなぎが入っていれば、もうカットではない。両方出すと矛盾する（2026-10-17）
        (bh.cut
          ? ((c.bridges ?? []).some((b) => b.afterPosition === bh.start - 1)
            ? `<span class="bridgenote">⤴ ここは直前のつなぎの曲で BPM を切り替え（カット不要）</span>`
            : `<span class="cutnote">✂ ここはカットで切り替え（前の塊と BPM が離れている）</span>`)
          : '') + `</td></tr>` : '') +
      (e.position === lockedUntil + 1 && lockedUntil > 0
        ? `<tr class="divider"><td colspan="9">ここから作り直す（上の ${lockedUntil} 曲は確定）</td></tr>` : '') +
      (bpmChanged ? `<tr class="divider"><td colspan="9">ここから ${e.bpm.toFixed(0)} BPM</td></tr>` : '');
    // **つなぎの曲**（✂ の所に solver が自動で挟んだもの）。曲番を持たない別の層なので、
    // 色を変え、番号の代わりに ⤴ を出す（ユーザー要求「トランジションだと分かるように色を変えて」）。
    // 差し替え・固定のボタンは出さない（本編の曲ではないため）。試聴だけできる。
    const bridgeRows = (c.bridges ?? []).filter((b) => b.afterPosition === e.position).map((b) => `
      <tr class="bridge">
        <td class="bpos">⤴</td>
        <td><div class="title"><span class="bridgetag">つなぎ</span>${esc(b.title)}</div>
            <div class="artist">${esc(b.artist)}　BPM を ${b.from} → ${b.to} に変える曲（カットの代わり）</div></td>
        <td class="len">${mmss(b.duration)}</td>
        <td class="nat">${b.from}→${b.to}</td>
        <td class="pitch">${Math.abs(b.pitch ?? 0) < 0.0005 ? '—' : `${b.pitch > 0 ? '+' : ''}${(b.pitch * 100).toFixed(1)}%`}</td>
        <td class="key">${esc(b.camelot ?? '??')}</td>
        <td class="grp">${b.bpmFrom.toFixed(1)} → ${b.bpmTo.toFixed(1)} BPM で鳴る</td>
        <td class="act">
          <button class="play" data-playb="${b.afterPosition}" title="試聴（つなぎの曲）">▶</button>
        </td>
      </tr>`).join('');
    return dividers + `
      <tr class="${locked ? 'locked' : ''}">
        <td class="pos">${e.position}</td>
        <td><div class="title">${esc(e.title)}${wishSet.has(e.basename) ? '<span class="wishtag" title="使いたい曲に選んだ曲">★ 使いたい曲</span>' : ''}${flags}</div><div class="artist">${esc(e.artist)}</div></td>
        <td class="len">${mmss(e.duration)}</td>
        <td class="nat">${(e.naturalBpm ?? e.bpm).toFixed(1)}</td>
        <td class="pitch ${hot ? 'hot' : ''}">${pitchTxt}</td>
        <td class="key">${esc(e.camelot ?? '??')}</td>
        <td class="grp">${esc(e.soundGroupLabel)}</td>
        <td class="act">
          <button class="play" data-play="${e.position}" title="試聴（曲の聞かせどころから）">▶</button>
          <button class="ins" data-ins="${e.position}" title="この曲の前に 1 曲入れる（キーと BPM が合う曲を選びます）">＋</button>
          <button data-drop="${e.position}" title="ここまでを確定して、この曲から先を 3 案作り直す">📌</button>
          <button data-swap="${e.position}" title="この 1 曲だけ替える。前後は動かさない">🔁</button>
          <button data-hist="${e.position}" ${historyOf(e.position).length ? '' : 'disabled'}
            title="${historyOf(e.position).length
              ? `この枠に前に入っていた曲（${historyOf(e.position).length} 曲）を聴いて、戻せます`
              : 'この曲はまだ替えていません（替えると前の曲に戻せるようになります）'}">🕘</button>
        </td>
      </tr>` + bridgeRows;
  }).join('');

  const maxP = Math.max(0, ...c.entries.map((e) => Math.abs(e.pitch ?? 0)));
  const over = c.entries.filter((e) => Math.abs(e.pitch ?? 0) > comfort).length;

  // **おまかせで何 BPM に決まったかを結果の上に出す。** 指定しない代わりに結果で見せる
  const bpmTxt = typeof last.setBpm === 'number' ? `${last.setBpm} BPM`
    : Array.isArray(last.setBpm) ? last.setBpm.map((x) => `${x.from} 曲目から ${x.bpm}`).join(' → ')
    : 'BPM は決めていない（原曲の速度のまま）';
  // **曲が足りないことを見逃させない。** 気づかずに本番へ出るのが一番困る
  // （2026-10-03 ユーザー指摘）。判断は solver がして、ここは出すだけ。
  // 長いセットのときは BPM の 1 行の代わりに塊の帯を出す（帯に BPM が入っている）
  // **総再生時間は結果の一番上に出す。**（下の hint に入れていたら気づけない。
  //  ユーザー報告「27 分で終わりそうになり、出すべきだったことが分かりにくかった」）
  const timeBanner = timeHtml(c) ? `<div class="banner">${timeHtml(c)}</div>` : '';
  $('sheet').innerHTML = shortfallHtml(c) + timeBanner + wishHtml(c) + (blocks ? blockStrip(blocks, c.bridges ?? []) : `
    <div class="banner">セットの BPM: <b>${esc(bpmTxt)}</b>${last.setBpmAuto ? ` <span class="dim">— ${esc(last.setBpmAuto)}</span>` : ''}</div>`) + `
    <table>
    <tr><th class="pos">#</th><th>曲 / アーティスト</th><th>長さ</th><th>原曲</th><th>ピッチ</th><th>key</th><th>音の群れ</th><th></th></tr>
    ${rows}</table>
    <div class="addrow">
      <button id="appendBtn" title="いちばん後ろに 1 曲足す（持ち時間が増えたとき）">＋ 後ろに追加</button>
    </div>
    <div class="hint" style="padding:10px 8px">
      ピッチ最大 ±${(maxP * 100).toFixed(1)}%${over ? ` / ±${(comfort * 100).toFixed(0)}% を超える曲 ${over} 曲（黄色）` : ' / 全曲 快適域内'}
    </div>`;

  if (blocks) wireBlocks(c, blocks);
  for (const b of document.querySelectorAll('[data-play]')) {
    b.onclick = guard('試聴', async () => {
      const pos = Number(b.dataset.play);
      const e = c.entries.find((x) => x.position === pos);
      if (e) await togglePreview(e, b);
    });
  }
  // つなぎの曲の試聴。曲番を持たないので afterPosition で引く
  for (const b of document.querySelectorAll('[data-playb]')) {
    b.onclick = guard('試聴', async () => {
      const at = Number(b.dataset.playb);
      const br = (c.bridges ?? []).find((x) => x.afterPosition === at);
      if (br) await togglePreview(br, b);
    });
  }
  for (const b of document.querySelectorAll('[data-drop]')) {
    b.onclick = guard('ここまで確定', async () => {
      const pos = Number(b.dataset.drop);
      // **今見ている案を土台にする。** 渡さないと常に案 A が使われる（実際にそうなっていた）
      const src = c._src ?? { json: last.jsonPath, idx: 1 };
      const d = await call(['--from', src.json, '--candidate', String(src.idx), '--drop', String(pos)],
        `${pos} 曲目から作り直し`);
      // ここから後ろの「別案」を 3 つ出すのが目的なので、案は総入れ替えでよい
      if (d) {
        // そこから後ろが総入れ替えになるので履歴は捨てる（別の曲の履歴を見せない）
        clearHistory();
        last = { ...last, ...d, candidates: tagSources(d, d.jsonPath), lockedUntil: pos - 1 };
        tabIndex = 0; render();
      }
    });
  }
  for (const b of document.querySelectorAll('[data-swap]')) {
    b.onclick = guard('曲の差し替え', async () => {
      const pos = Number(b.dataset.swap);
      const src = c._src ?? { json: last.jsonPath, idx: 1 };
      const before = c.entries.find((e) => e.position === pos);
      const d = await call(['--from', src.json, '--candidate', String(src.idx), '--swap', String(pos)],
        `${pos} 曲目を差し替え`);
      if (!d) return;
      // **差し替えは「その案を編集する」操作。** 他の案は消さずに残し、見ている案だけ入れ替える。
      // （差し替えは残りを全部固定するので 1 案しか返らない。総入れ替えにすると案が 1 つに減る）
      const fresh = tagSources(d, d.jsonPath)[0];
      const after = fresh.entries.find((e) => e.position === pos);
      last = {
        ...last,
        candidates: last.candidates.map((x, i) => (i === tabIndex ? fresh : x)),
      };
      // **外した曲を履歴に積む。** render() の前に積むと 🕘 がすぐ押せる状態で描ける
      pushHistory(pos, before);
      render();
      if (before && after) {
        $('msg').textContent = `${pos} 曲目を差し替えました: 「${before.title}」→「${after.title}」`
          + `　🕘 で前の曲に戻せます`;
      }
    });
  }

  // **履歴。** その枠に前に入っていた曲を聴いて、戻す（ユーザー要求 2026-10-21）。
  for (const b of document.querySelectorAll('[data-hist]')) {
    if (b.disabled) continue;
    b.onclick = guard('履歴', () => openHistory(Number(b.dataset.hist)));
  }

  // **曲を 1 曲足す。** 足す枠以外を全部固定して solver に解かせるので、入るのは
  // 「セトリに無い曲」で、キー・BPM・箱・時間帯の条件は土台の指定を引き継ぐ。
  // 画面側で曲を選んではいけない（solver のロジックを画面に持たない約束）。
  for (const bi of document.querySelectorAll('[data-ins]')) {
    bi.onclick = guard('ここに挿入', () => addTrack('insert', Number(bi.dataset.ins)));
  }
  $('appendBtn').onclick = guard('後ろに追加', () => addTrack('append', c.entries.length + 1));

  // **書き出しは明示的に。** out/ は実行のたびに増える作業場なので、
  // 「どれを使うのか」が分からなくなる（2026-08-08 ユーザー指摘）
  $('status').innerHTML = `<span class="grow" id="msg">${esc($('msg').textContent)}</span>
    <button class="mini" id="saveSet" title="このセトリに名前を付けて保存する（あとで左の一覧から呼び出せます）">💾 保存</button>
    <button class="mini" id="cueExport" title="このセトリのうち**まだレコボにＱが無い曲だけ**を XML に書き出します（頭/イントロ終/始まり/メイン…/アウトロ）。既にＱがある曲は XML に入りません。取り込んだあと、曲の並びは ⬇ 書き出す（.m3u8）で渡します">Ｑを仮置き（XML）</button>
    <button id="export" title="rekordbox のプレイリスト（.m3u8）として書き出す。曲の並びだけを渡すので、レコボ側の BPM・拍位置・キーは書き換わりません">⬇ 書き出す</button>`;
  $('saveSet').onclick = guard('保存', () => openSaveBar(c));
  // 書き出しの既定の名前。**Ｑ付きと普通で同じ作り**にする（並べたときに対応が分かるように）。
  // **拡張子が形式の正本**（main.js がこれを見てダイアログの絞り込みを決める）:
  //   普通   = `.m3u8`（rekordbox のプレイリスト。曲の並びとパスだけを渡す）
  //   Ｑ付き = `.xml`（POSITION_MARK を渡す欄が m3u8 に無いので XML しかない）
  const exportName = (suffix = '', ext = 'm3u8') => {
    const bpm = typeof last.setBpm === 'number' ? `${last.setBpm}BPM`
      : Array.isArray(last.setBpm) ? `${last.setBpm[0].bpm}-${last.setBpm[last.setBpm.length - 1].bpm}BPM` : '';
    const venue = last.blocks ? '長いセット' : ($('venue').selectedOptions[0]?.textContent.replace(/（.*/, '') ?? '');
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `セトリ_${day}_${venue}_${bpm}_${c.entries.length}曲_案${String.fromCharCode(65 + tabIndex)}${suffix}.${ext}`
      .replace(/[\\/:*?"<>|]/g, '_');
  };

  // **メモリーＱを打って書き出す。** 普通の書き出しとは別のボタン（ユーザー指示 2026-10-17）。
  // 音源を全長デコードするので 1 曲 0.3 秒。押してから数秒かかるので待っていることを出す。
  $('cueExport').onclick = guard('Ｑ付きで書き出し', async () => {
    const btn = $('cueExport'), was = btn.textContent;
    btn.disabled = true; btn.textContent = 'Ｑを打っています…';
    $('msg').textContent = `${c.entries.length} 曲の音源を読んでＱの位置を決めています（1 曲 0.3 秒ほど）…`;
    let r;
    try { r = await window.dj.cueExport({ xmlPath: c.files.xml }); }
    finally { btn.disabled = false; btn.textContent = was; }
    if (!r.ok) { $('msg').textContent = 'Ｑを打てませんでした: ' + (r.error ?? ''); return; }
    const saved = await window.dj.exportSet({ filePath: r.out, suggested: exportName('_Ｑ付き', 'xml') });
    if (saved.canceled) return;
    if (!saved.ok) { $('msg').textContent = '書き出せませんでした: ' + (saved.error ?? ''); return; }
    // **打たなかった曲を必ず言う。** 既にＱがある曲は触っていないので、
    // 「全曲に入ったつもりで本番に出る」のを防ぐ（曲はセットから消えていない）
    const touched = (r.report ?? []).filter((x) => !x.ok);
    $('msg').textContent = `Ｑ付きで書き出しました: ${saved.saved.split(/[\\/]/).pop()}`
      + `　（${r.wrote}/${r.tracks} 曲にＱを打ちました`
      + (touched.length ? ` / 打たなかった ${touched.length} 曲: ${touched.map((x) => x.name).join('、')}` : '')
      + '）　★ アウトロは当たりが 3 割なので rekordbox で目で直してください';
    window.dj.reveal(saved.saved);
  });

  $('export').onclick = guard('書き出し', async () => {
    // **渡すのは rekordbox のプレイリスト（.m3u8）**（ユーザー指示 2026-10-21）。
    // コレクション XML はもう渡さない。XML は `AverageBpm` などの欄を持っているので、
    // 取り込みの問いに「はい」と答えると**ロックしていない曲の拍位置とキーが上書きされうる**
    // （2026-10-19 に実機で確認）。並びを渡すだけなら m3u8 で足り、レコボ側に一切触らない。
    const r = await window.dj.exportSet({ filePath: c.files.m3u, suggested: exportName() });
    if (r.canceled) return;
    if (!r.ok) { $('msg').textContent = '書き出せませんでした: ' + (r.error ?? ''); return; }
    // **足りないまま書き出したときは、そのことも一緒に言う**
    const short = shortOf(c);
    $('msg').textContent = `書き出しました: ${r.saved.split(/[\\/]/).pop()}`
      + '  → rekordbox の「ファイル > 読み込み」からプレイリストとして読み込めます'
      + '（曲の並びだけを渡すので、レコボ側の BPM・拍位置・キーは書き換わりません）'
      + (short ? `　★ ただし約 ${short.missingMinutes} 分足りないセトリです（${short.gotTracks} 曲 / 要求 ${short.askedTracks} 曲）` : '');
    window.dj.reveal(r.saved);
  });
}

/**
 * **履歴のダイアログ。** その枠に前に入っていた曲を並べ、聴いてから戻せるようにする。
 *
 * 戻すのは solver の `--put <位置>:<ファイル名>`。**曲を名指しする唯一の操作**
 * （差し替えは「違う曲を選ばせる」操作なので、これとは別の経路）。
 * 前後の曲は 1 曲も動かない（他の位置を全部固定して解き直す）。
 */
function openHistory(pos) {
  if (!last) return;
  const c = last.candidates[tabIndex];
  const now = c?.entries.find((e) => e.position === pos);
  const past = historyOf(pos);
  $('histTitle').textContent = `${pos} 曲目の履歴（${past.length} 曲）`;
  const row = (x, isNow) => `
    <div class="histrow ${isNow ? 'now' : ''}">
      <button class="play" data-histplay="${isNow ? 'now' : x.basename}" title="試聴（曲の聞かせどころから）">▶</button>
      <span class="t"><b>${esc(x.title)}</b> <span class="dim">${esc(x.artist ?? '')}</span>
        <div class="dim" style="font-size:10px">${esc(x.basename)}</div></span>
      <span class="dim">${(x.naturalBpm ?? x.bpm ?? 0).toFixed(1)}</span>
      <span class="dim">${esc(x.camelot ?? '??')}</span>
      ${isNow
        ? '<span class="dim">いま入っている曲</span>'
        : `<span class="when">${esc(x.at ?? '')}</span>
           <button data-histput="${esc(x.basename)}" title="この曲に戻す。前後の曲は動きません">これに戻す</button>`}
    </div>`;
  // **いま入っている曲を上に出す。** どれが現役か分からないと戻す判断ができない
  $('histList').innerHTML = (now ? row(now, true) : '')
    // 新しく外したものを上に（直前に外した曲が一番戻したい曲）
    + [...past].reverse().map((x) => row(x, false)).join('');
  $('histModal').classList.remove('hidden');

  for (const b of document.querySelectorAll('#histList [data-histplay]')) {
    b.onclick = guard('試聴', async () => {
      const k = b.dataset.histplay;
      const x = k === 'now' ? now : past.find((y) => y.basename === k);
      if (!x) return;
      if (!x.path) { $('msg').textContent = 'この曲は音源の場所が分かりません'; return; }
      await togglePreview(x, b);
    });
  }
  for (const b of document.querySelectorAll('#histList [data-histput]')) {
    b.onclick = guard('前の曲に戻す', async () => {
      const bn = b.dataset.histput;
      stopPreview();
      const src = c._src ?? { json: last.jsonPath, idx: 1 };
      const d = await call(['--from', src.json, '--candidate', String(src.idx), '--put', `${pos}:${bn}`],
        `${pos} 曲目を前の曲に戻す`);
      if (!d) return;
      const fresh = tagSources(d, d.jsonPath)[0];
      const after = fresh.entries.find((e) => e.position === pos);
      // **戻す前に入っていた曲も履歴に積む。** 行き来できないと「戻しすぎた」が直せない
      pushHistory(pos, now);
      last = { ...last, candidates: last.candidates.map((x, i) => (i === tabIndex ? fresh : x)) };
      $('histModal').classList.add('hidden');
      render();
      $('msg').textContent = after
        ? `${pos} 曲目を「${after.title}」に戻しました（前後の曲は動いていません）`
        : `${pos} 曲目を戻しました`;
    });
  }
}

/**
 * 曲を 1 曲足す。`mode` は 'insert'（pos の前に入れる）か 'append'（いちばん後ろ）。
 *
 * **選曲は solver に任せる。** 足す 1 枠以外を全部固定して解き直すので、
 * 既にセトリに入っている曲は選ばれない（beam の重複判定がそのまま効く）。
 * キーの隣接（5A なら 5A/5B/4A/6A…）も BPM も箱も時間帯も、土台にした
 * request をそのまま引き継ぐので指定どおりになる。
 */
async function addTrack(mode, pos) {
  if (!last) return;
  const c = last.candidates[tabIndex];
  if (!c) return;
  const src = c._src ?? { json: last.jsonPath, idx: 1 };
  const argv = mode === 'append'
    ? ['--from', src.json, '--candidate', String(src.idx), '--append']
    : ['--from', src.json, '--candidate', String(src.idx), '--insert', String(pos)];
  const d = await call(argv, mode === 'append' ? '後ろに 1 曲追加' : `${pos} 曲目の前に挿入`);
  if (!d) return;
  // 1 案しか返らない（残りを全部固定しているため）。**見ている案だけ入れ替える**
  const fresh = tagSources(d, d.jsonPath)[0];
  const at = d.added?.position ?? pos;
  const got = fresh.entries.find((e) => e.position === at);
  const locked = last.lockedUntil ?? 0;
  last = {
    ...last,
    candidates: last.candidates.map((x, i) => (i === tabIndex ? fresh : x)),
    // 確定済みの前に入れたら、確定の位置も 1 つ下へずれる
    lockedUntil: at <= locked ? locked + 1 : locked,
  };
  // **挿入で番号が動いたら履歴もずらす。** ずらさないと 🕘 が 1 つ手前の行にぶら下がる
  if (mode !== 'append') shiftHistory(at);
  render();
  $('msg').textContent = got
    ? `${at} 曲目に「${got.title}」を入れました（${d.added?.before ?? '?'} 曲 → ${d.added?.after ?? fresh.entries.length} 曲 / key ${got.camelot ?? '??'}）`
    : '入れられる曲が見つかりませんでした（キーや BPM の条件に合う曲がプールにありません）';
}

// --- セトリ候補の保存と呼び出し -------------------------------------------
//
// **out/ は 7 日で消える作業場。** 残したいものは名前を付けて data/setlists/ に置く。
// 保存したファイルはそのまま solver の --from に渡せる形なので、呼び出したあとも
// 「替える」「ここまで確定」「ここに挿入」「後ろに追加」が全部効く。

/** いちばん多い音の群れ。保存名の既定に使う（ジャンルのテキストは 8/8 に捨てたため） */
function dominantGroup(entries) {
  const n = new Map();
  for (const e of entries ?? []) {
    const k = e.soundGroupLabel;
    if (k) n.set(k, (n.get(k) ?? 0) + 1);
  }
  let best = null, max = 0;
  for (const [k, v] of n) if (v > max) { max = v; best = k; }
  return best;
}

/** 既定の保存名 = 音の群れ + yymmdd。**変えられる**（既定を用意するだけ） */
function defaultSaveName(c) {
  const g = dominantGroup(c.entries)
    ?? ($('venue').selectedOptions[0]?.textContent.replace(/（.*/, '').trim() || 'セトリ');
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${g}_${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function openSaveBar(c) {
  $('saveBar').classList.remove('hidden');
  const inp = $('saveName');
  inp.value = defaultSaveName(c);
  inp.focus();
  inp.select();
}

function closeSaveBar() { $('saveBar').classList.add('hidden'); }

async function doSave() {
  if (!last) return;
  const c = last.candidates[tabIndex];
  if (!c) return;
  const name = $('saveName').value.trim() || defaultSaveName(c);
  // **いま見ている案だけを保存する。** 保存ファイルを --from に渡せる形に揃えるため
  const payload = { ...last, candidates: [{ ...c, _src: undefined }], jsonPath: undefined };
  const r = await window.dj.setlistSave({
    name, payload,
    ui: { candidateIndex: 0, lockedUntil: last.lockedUntil ?? 0 },
  });
  closeSaveBar();
  if (!r.ok) { $('msg').textContent = '保存できませんでした: ' + (r.error ?? ''); return; }
  $('msg').textContent = `「${r.name}」として保存しました（左の一覧から呼び出せます）`;
  await loadSavedList();
}

/** 保存の一覧。消すのは 2 段（押し間違いで消えると取り返しが付かない） */
let pendingDelete = null;
async function loadSavedList() {
  const box = $('savedList');
  // **ここで例外を出して初期化を止めない。** 止めると群の一覧も出ず画面が死ぬ
  // （db-ready を偽装し忘れて通しテストを固めた 2026-10-03 の件と同じ型）
  let r = null;
  try {
    r = await window.dj.setlistList();
  } catch (e) {
    console.warn('setlist-list を呼べませんでした: ' + e.message);
    box.innerHTML = '<span class="hint">一覧を読めませんでした</span>';
    return;
  }
  if (!r.ok) { box.innerHTML = '<span class="hint">一覧を読めませんでした</span>'; return; }
  if (!r.items.length) { box.innerHTML = '<span class="hint">まだありません</span>'; return; }
  box.innerHTML = r.items.map((it) => `
    <div class="item">
      <span class="nm" title="${esc(it.name + (it.firstTitle ? '  /  1 曲目: ' + it.firstTitle : ''))}">${esc(it.name)}</span>
      <span class="meta">${it.n}曲 ${it.minutes}分</span>
      <button data-sload="${it.id}" title="このセトリを編集画面に呼び出す">📂</button>
      <button data-sdel="${it.id}" title="この保存を消す">${pendingDelete === it.id ? '✓' : '🗑'}</button>
    </div>`).join('');
  for (const b of box.querySelectorAll('[data-sload]')) {
    b.onclick = guard('セトリの呼び出し', () => openSaved(b.dataset.sload));
  }
  for (const b of box.querySelectorAll('[data-sdel]')) {
    b.onclick = guard('セトリの削除', async () => {
      const id = b.dataset.sdel;
      if (pendingDelete !== id) {
        // 1 回目は確認。3 秒で戻す（ダイアログは画面を止めるので使わない）
        pendingDelete = id;
        await loadSavedList();
        $('msg').textContent = 'もう一度 ✓ を押すと消します';
        setTimeout(() => { if (pendingDelete === id) { pendingDelete = null; loadSavedList(); } }, 3000);
        return;
      }
      pendingDelete = null;
      const r2 = await window.dj.setlistDelete(id);
      $('msg').textContent = r2.ok ? '消しました' : '消せませんでした: ' + (r2.error ?? '');
      await loadSavedList();
    });
  }
}

/** 保存を編集画面に呼び出す。**--from はこの保存ファイル自身を指す** */
async function openSaved(id) {
  const r = await window.dj.setlistLoad(id);
  if (!r.ok) { $('msg').textContent = '呼び出せませんでした: ' + (r.error ?? ''); return; }
  const d = r.data;
  last = {
    ...d,
    jsonPath: r.file,
    candidates: tagSources(d, r.file),
    lockedUntil: Number(d.ui?.lockedUntil ?? 0),
  };
  tabIndex = 0;
  render();
  const n = last.candidates[0]?.entries?.length ?? 0;
  $('msg').textContent = `「${d.savedName ?? id}」を呼び出しました（${n} 曲）。そのまま編集できます`;
}
/**
 * この案が要求の曲数に届いているか。届いていなければ不足の中身を返す。
 *
 * **判断そのものは solver がしている**（payload.shortfall / askedTracks）。
 * ここでやるのは「いま見ている案」に当てはめる引き算だけ。
 * 案ごとに曲数が違うことがあるので、案単位で見る必要がある。
 */
function shortOf(c) {
  if (!last || !c) return null;
  // 案ごとの要求曲数（持ち時間に合わせて案ごとに決まる。2026-10-21）。古い結果には無い
  const asked = Number(c.askedTracks ?? last.askedTracks ?? 0);
  const got = c.entries.length;
  if (!(asked > 0) || got >= asked) return null;
  const per = Number(last.minutesPerTrack ?? 2.31);
  const askedMinutes = last.askedMinutes ?? null;
  return {
    askedTracks: asked,
    gotTracks: got,
    askedMinutes,
    gotMinutes: Math.round(got * per),
    missingMinutes: Math.round((asked - got) * per),
    reason: last.shortfall?.reason ?? null,
  };
}

/**
 * **総再生時間の 1 行。** 曲数 x 2.31 分の見込みではなく、選ばれた曲の実長から出した時間。
 *
 * なぜ要るか（ユーザー報告 2026-10-17）: 「30 分セットの時にやってみると 27 分くらいで
 * 終わりそうになり、出すべきだったことが分かりにくかった」。曲数だけ見ていると気づけない。
 * **計算は solver がしている**（candidates[].minutes）。ここは出すだけ。
 */
function timeHtml(c) {
  if (c.minutes == null) return '';
  const nb = (c.bridges ?? []).length;
  const asked = last?.askedMinutes ?? null;
  const diff = asked != null ? c.minutes - asked : null;
  // **不足は 1 分でも言う。超過は警告しない**（2026-10-21 ユーザー:「ちょっと長いくらいで良い」）
  const judge = diff == null ? ''
    : diff < 0 ? ` <b style="color:var(--warn)">— 持ち時間 ${asked} 分に ${-diff} 分足りません</b>`
    : diff > 0 ? ` — 持ち時間 ${asked} 分を満たします（${diff} 分長め）`
    : ` — 持ち時間 ${asked} 分ちょうど`;
  return `総再生時間 <b>約 ${c.minutes} 分</b>（${c.entries.length} 曲${nb ? ` + つなぎ ${nb}` : ''}。` +
    `曲の実長 ${c.rawMinutes} 分のうち鳴らすぶん。曲数の換算では ${c.planMinutes} 分）${judge}`;
}

/** 足りないときの警告。足りていれば空文字 */
function shortfallHtml(c) {
  const s = shortOf(c);
  if (!s) return '';
  const head = s.askedMinutes != null
    ? `指定 ${s.askedMinutes} 分に対して、組めたのは約 ${s.gotMinutes} 分ぶん（${s.gotTracks} 曲 / 要求 ${s.askedTracks} 曲）`
    : `要求 ${s.askedTracks} 曲に対して ${s.gotTracks} 曲しか組めませんでした`;
  return `<div class="alert">
    <div class="big">⚠ 曲が足りません${s.askedMinutes != null ? ` — 約 ${s.missingMinutes} 分不足` : ''}</div>
    <div>${esc(head)}</div>
    ${s.reason ? `<div>理由: ${esc(s.reason)}</div>` : ''}
    <div class="how">増やすには: 音の群れを増やす / アニソンを「入れる」/ 時間帯の指定を外す / 箱を変える / 持ち時間を短くする</div>
  </div>`;
}

/**
 * 案ごとの「出どころ」を覚えておく。
 *
 * **なぜ要るか**: --drop / --swap は「前の結果 JSON の何番目の案か」を指して呼ぶ。
 * 案 C を編集すると新しい JSON には 1 案しか入らないので、そのあと案 A を編集しようとすると
 * 参照先が失われる。だから **案ごとに「どのファイルの何番目か」を持たせる。**
 */
function tagSources(data, jsonPath) {
  return data.candidates.map((c, i) => ({ ...c, _src: { json: jsonPath, idx: i + 1 } }));
}

async function build(extra, what) {
  const d = await call(orderArgv(extra), what);
  if (d) {
    blockLocks = new Set();
    clearHistory();                 // 別の曲が並ぶので、前の履歴は意味を失う
    last = { ...d, candidates: tagSources(d, d.jsonPath), lockedUntil: 0 };
    tabIndex = 0; render();
  }
}

// --- 長いセット: 札のチェック欄 ---
function renderCards() {
  const animeOn = $('anime').value !== 'exclude';
  $('cards').innerHTML = cardList.map((c) => `
    <label><input type="checkbox" value="${c.id}" ${(c.anime ? animeOn : c.default_on) ? 'checked' : ''}>
      <span>${esc(c.label)}</span><span class="n">段 ${c.level}</span></label>`).join('');
  for (const el of document.querySelectorAll('#cards input')) el.onchange = () => onCardToggle(el);
}

/**
 * **結果が出たあとで札を外したら、その札の塊だけ置き換えるかを聞く。**
 * 例: アニソンを使えない箱だと分かった → アニソンの塊だけ前後に合う別ジャンルへ。他の塊は残る。
 */
function onCardToggle(el) {
  const box = $('cardNotice');
  box.innerHTML = '';
  if (el.checked || !last?.blocks) return;
  const c = last.candidates[tabIndex];
  const hit = last.blocks.filter((b) => b.card === el.value);
  if (!hit.length) return;
  const label = cardList.find((x) => x.id === el.value)?.label ?? el.value;
  box.innerHTML = `<div class="hint" style="font-size:11px">今の案に「${esc(label)}」の塊が ${hit.length} つあります</div>
    <button class="mini" id="removeCardBtn" style="margin-top:4px">その塊だけ別のジャンルに置き換える</button>`;
  $('removeCardBtn').onclick = guard('札を外す', async () => {
    box.innerHTML = '';
    await blockCall(c, ['--remove-cards', el.value], `「${label}」の塊を置き換え`);
  });
}

/** 塊の操作を呼ぶ。鍵をかけた塊は必ず渡す（触らせない） */
async function blockCall(c, args, what) {
  const src = c._src ?? { json: last.jsonPath, idx: 1 };
  const keep = blockLocks.size ? ['--keep-blocks', [...blockLocks].map((i) => i + 1).join(',')] : [];
  const d = await call(['--from', src.json, '--candidate', String(src.idx), ...args, ...keep], what);
  if (d) {
    last = { ...last, ...d, candidates: tagSources(d, d.jsonPath), lockedUntil: 0 };
    tabIndex = 0; render();
  }
}

/** その塊に置ける札。前後と同じ札でなく、盛り上がりが 1 段ずつの決まりを守るもの */
function cardsFor(blocks, i) {
  const lv = (id) => cardList.find((x) => x.id === id)?.level ?? 0;
  const on = new Set((last.cards ?? []).filter((x) => x.on).map((x) => x.id));
  const prev = blocks[i - 1], next = blocks[i + 1];
  return cardList.filter((c) => on.has(c.id) && c.id !== blocks[i].card
    && (!prev || (c.id !== prev.card && c.level <= lv(prev.card) + 1))
    && (!next || (c.id !== next.card && lv(next.card) <= c.level + 1)));
}

/** 塊の帯。1 枚ごとに 鍵 / 選び直す / ジャンルを替える */
function blockStrip(blocks, bridges = []) {
  // ✂ の所につなぎが入っていれば印を ⤴ に変える。カットと両方出すと矛盾する（2026-10-17）
  const bridged = new Set(bridges.map((x) => x.afterPosition + 1));
  return `<div class="strip">` + blocks.map((b) => {
    const opts = cardsFor(blocks, b.index);
    return (b.cut
      ? (bridged.has(b.start)
        ? `<span class="bridgemark" title="つなぎの曲で BPM を変える（カットしない）">⤴</span>`
        : `<span class="cutmark" title="カットで BPM を切り替える">✂</span>`)
      : '') + `
      <div class="chip ${blockLocks.has(b.index) ? 'locked' : ''}">
        <div class="h">${b.index + 1}. ${esc(b.label)}</div>
        <div class="s">${b.n} 曲 / ${b.bpm} BPM / 段 ${b.level}</div>
        <div class="c">
          <button data-lock="${b.index}" title="鍵をかけると、全部選び直す・札を外すでも残る">${blockLocks.has(b.index) ? '🔒' : '🔓'}</button>
          <button data-redo="${b.index}" title="同じジャンルのまま、この塊の曲だけ選び直す">選び直す</button>
          <select data-setcard="${b.index}" title="この塊のジャンルを替える（前後とつながるものだけ）">
            <option value="">ジャンル…</option>
            ${opts.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}
          </select>
        </div>
      </div>`;
  }).join('') + `</div>
    <div class="row" style="margin-bottom:8px">
      <button class="mini" id="redoAll" title="鍵をかけていない塊の曲を全部選び直す（並びはそのまま）">鍵のない塊を全部選び直す</button>
      <span class="dim">✂ = カットで BPM を切り替える境目。⤴ = つなぎの曲で変える。塊の中はミックスでつなぐ</span>
    </div>`;
}

function wireBlocks(c, blocks) {
  for (const b of document.querySelectorAll('[data-lock]')) {
    b.onclick = () => {
      const i = Number(b.dataset.lock);
      if (blockLocks.has(i)) blockLocks.delete(i); else blockLocks.add(i);
      render();
    };
  }
  for (const b of document.querySelectorAll('[data-redo]')) {
    b.onclick = guard('塊の選び直し', async () => {
      const i = Number(b.dataset.redo);
      await blockCall(c, ['--redo-block', String(i + 1)], `${i + 1} 番目の塊を選び直し`);
    });
  }
  for (const sel of document.querySelectorAll('[data-setcard]')) {
    sel.onchange = guard('ジャンルの変更', async () => {
      if (!sel.value) return;
      const i = Number(sel.dataset.setcard);
      await blockCall(c, ['--set-block', `${i + 1}:${sel.value}`], `${i + 1} 番目の塊のジャンルを変更`);
    });
  }
  $('redoAll').onclick = guard('全部選び直す', async () => {
    if (blockLocks.size === blocks.length) { $('msg').textContent = '全部の塊に鍵がかかっています'; return; }
    await blockCall(c, ['--redo-block', 'all'], '鍵のない塊を選び直し');
  });
}

// クリック 1 つで画面全体が死なないよう、必ず包む
const guard = (where, fn) => async (...a) => {
  try { await fn(...a); } catch (e) { showFatal(where, e); $('go').disabled = false; }
};

$('go').onclick = guard('組み立て', () => build([], '組み立て'));
// おまかせ = 毎回違う種を渡す。HARD 制約は一切ゆるめない
$('shuffle').onclick = guard('おまかせ', () => build(['--shuffle'], 'おまかせ'));
$('findBtn').onclick = guard('曲の検索', doFind);
$('longOn').onchange = () => {
  const on = isLong();
  for (const el of document.querySelectorAll('.shortOnly')) el.classList.toggle('hidden', on);
  $('cardBox').classList.toggle('hidden', !on);
  // 長いセットは 1 時間から。30 分のままなら 60 にしておく
  if (on && Number($('minutes').value) <= 30) $('minutes').value = '60';
};
$('anime').onchange = () => renderCards();
$('anchorQ').onkeydown = (e) => { if (e.key === 'Enter') doFind(); };
$('histClose').onclick = () => { stopPreview(); $('histModal').classList.add('hidden'); };
$('histModal').onclick = (e) => {
  if (e.target === $('histModal')) { stopPreview(); $('histModal').classList.add('hidden'); }
};
$('wishOpen').onclick = () => { $('wishModal').classList.remove('hidden'); renderWishList(); $('wishQ').focus(); };
$('wishDone').onclick = () => $('wishModal').classList.add('hidden');
$('wishModal').onclick = (e) => { if (e.target === $('wishModal')) $('wishModal').classList.add('hidden'); };
$('wishClear').onclick = () => { wishes = []; renderWishList(); renderWishHits(); };
$('wishFind').onclick = guard('曲の検索', doWishFind);
$('wishQ').onkeydown = (e) => {
  if (e.key === 'Enter') doWishFind();
  if (e.key === 'Escape') $('wishModal').classList.add('hidden');
};
$('phaseOn').onchange = () => $('phaseBox').classList.toggle('hidden', !$('phaseOn').checked);
$('bpmMode').onchange = () => {
  const fixed = $('bpmMode').value === 'fixed';
  $('bpmBox').classList.toggle('hidden', !fixed);
  $('bpmHint').textContent = fixed
    ? '原曲から ±5% まで寄せる（±3% を超えると黄色になる）'
    : '締めの曲を決めればその曲に合わせます。決めなければ候補の真ん中を取ります';
};
// 箱を変えたら、自分で決めるときの初期値も変える
$('venue').onchange = () => {
  const d = { edm: 128, pops: 126, lowbeat: 100 }[$('venue').value];
  if (d) $('bpm1').value = String(d);
};

// --- 曲を足したとき ---
//
// rekordbox で曲を足したら XML を書き出してここで読み込む。**増えた分だけ**解析する。
// 済んだ曲を飛ばす仕組みは analyzer 側にあるので、間違って 2 回押しても無駄には走らない。
//
// 判断が要らないのは、ジャンルのテキストを捨てて音の群れに切り替えたため。
// 未知のジャンル名が来ても音の群れは必ず付くので、新しい曲が選曲から漏れることがない。
const PHASE_LABEL = { copy: '取り込み', meta: '曲名やジャンルの更新', analyze: '増えた曲の解析', envelope: '曲の起伏' };
let ingesting = false;

function ingestLine(text) {
  const box = $('ingestLog');
  box.textContent = (box.textContent + text + '\n').split('\n').slice(-200).join('\n');
  box.scrollTop = box.scrollHeight;
}

window.dj.onIngest((m) => {
  if (m.done && m.total) {
    $('ingestBar').firstElementChild.style.width = `${Math.round((m.done / m.total) * 100)}%`;
    $('ingestHint').textContent = `${PHASE_LABEL[m.phase] ?? m.phase}: ${m.done} / ${m.total} 曲`;
  } else if (m.phase && !m.done) {
    $('ingestHint').textContent = `${PHASE_LABEL[m.phase] ?? m.phase} …`;
  }
  if (m.line) ingestLine(m.line);
});

async function doIngest() {
  if (ingesting) return;
  const xml = await window.dj.pickXml();
  if (!xml) return;

  ingesting = true;
  $('ingestBtn').disabled = true;
  $('ingestStop').classList.remove('hidden');
  $('ingestProg').classList.remove('hidden');
  $('ingestLog').textContent = '';
  $('ingestBar').firstElementChild.style.width = '0%';

  const before = await window.dj.dbCount();
  const r = await window.dj.ingest(xml);
  const after = await window.dj.dbCount();

  ingesting = false;
  $('ingestBtn').disabled = false;
  $('ingestStop').classList.add('hidden');

  const added = (after?.done ?? 0) - (before?.done ?? 0);
  if (r.cancelled) {
    // **途中で止めても壊れない。** analyzer は 1 曲ごとに DB へ書くので、次に押せば続きから
    $('ingestHint').textContent = `やめました（${added} 曲ぶんは残っています。もう一度押せば続きから）`;
    return;
  }
  if (!r.ok) {
    $('ingestHint').textContent = '読み込めませんでした';
    ingestLine('\n★ ' + r.error);
    return;
  }
  $('ingestBar').firstElementChild.style.width = '100%';
  // **「ファイルが見つからない」は毎回出るが異常ではない。**
  // rekordbox に登録が残っているだけで実ファイルが無い曲（今 15 曲）を毎回試すため。
  // これを説明しないと、ログの SKIP を見て壊れたと思われる。
  const miss = after?.skipped ?? 0;
  const note = miss ? `／ ファイルが見つからない曲が ${miss} 曲（rekordbox に登録だけ残っているもの。放置してかまいません）` : '';
  // **曲数が取れなくても解析そのものは終わっている。**
  // 以前はここで `after.done` を素で読み、曲数が null のときに画面が落ちていた
  // （2026-10-03。実害は「取り込みは成功したのにエラー表示」）。数えられない事情は
  // 黒い窓の `[曲数が数えられません]` に出る。
  if (!after) {
    $('ingestHint').textContent = '取り込みは終わりました（曲数を数えられませんでした）。そのまま「作る」で使えます' + note;
    ingestLine('\n※ 曲数の集計だけ失敗しました。解析結果は保存されています。');
  } else {
    $('ingestHint').textContent = (added > 0
      ? `${added} 曲ふえました（全 ${after.done} 曲）。そのまま「作る」で使えます`
      : `増えた曲はありませんでした（全 ${after.done} 曲）。曲名やジャンルの変更は反映されています`) + note;
  }
  // 群ごとの曲数が変わるので数え直す。**0 曲から入った場合はここで初めて作れるようになる**
  if (await checkDb()) await loadGroups();
}

$('ingestBtn').onclick = guard('曲の追加', doIngest);
$('ingestStop').onclick = guard('中止', () => window.dj.ingestCancel());

/**
 * **まだ 1 曲も解析されていないときに何をすればよいか言う。**
 * features.db が無い機械（clone 直後 / DB をコミットしない運用）では solver が必ず
 * 失敗する。以前はここで「読めませんでした」としか出ず、XML を読み込めば直ることが
 * 画面から分からなかった（2026-10-03。DB 無しの経路は一度も確かめられていなかった）。
 * 戻り値 true = 曲がある。
 */
async function checkDb() {
  // **ここで例外を出して画面を止めない。** 止めると群の一覧も出ず、原因も見えない。
  // 曲があるかどうかが分からないときは、これまで通り（作れる前提）で続ける
  let st = null;
  try {
    st = await window.dj.dbReady();
  } catch (e) {
    console.warn('db-ready を呼べませんでした: ' + e.message);
    return true;
  }
  const empty = !st || !st.exists || st.done === 0;
  $('go').disabled = empty;
  $('shuffle').disabled = empty;
  if (!empty) return true;
  const why = !st || !st.exists
    ? 'まだ解析結果（features.db）がありません。'
    : 'まだ 1 曲も解析されていません。';
  $('sheet').innerHTML = '<div class="empty">' + why
    + '<br><br>rekordbox で「コレクションを XML に書き出し」をして、'
    + '下の<b>「XML を読み込み」</b>でそのファイルを選んでください。<br>'
    + '選んだあとは自動で解析します（曲数しだいで時間がかかります）。</div>';
  $('msg').textContent = '曲がありません。XML を読み込んでください';
  $('groups').innerHTML = '<span style="color:var(--dim)">XML を読み込むと出ます</span>';
  return false;
}

// --- ⚙ 設定 -----------------------------------------------------------------
//
// 持ち時間の上限。既定 120 分。6 時間回す人もいるので画面から変えられる
// （2026-10-03 ユーザー要望）。置き場所は config/venues.json で solver と共有する。
async function loadSettings() {
  let r = null;
  try { r = await window.dj.settingsGet(); } catch (e) { console.warn('settings-get: ' + e.message); return; }
  if (!r || !r.ok) { $('maxMinutesHint').textContent = '設定を読めませんでした'; return; }
  $('maxMinutes').value = String(r.maxMinutes);
  $('maxMinutes').max = String(r.hardMaxMinutes);
  // 持ち時間の入力にも同じ上限を効かせる（入れてから断られるより、入れられない方がよい）
  $('minutes').max = String(r.maxMinutes);
  $('maxMinutesHint').textContent =
    `これより長い持ち時間は入れられません（${r.minMinutes}〜${r.hardMaxMinutes} 分の範囲で変えられます）`;
}

$('maxMinutesSave').onclick = guard('設定の保存', async () => {
  const r = await window.dj.settingsSetMaxMinutes($('maxMinutes').value.trim());
  if (!r.ok) { $('maxMinutesHint').textContent = r.error; return; }
  $('minutes').max = String(r.maxMinutes);
  $('maxMinutesHint').textContent = `持ち時間の上限を ${r.maxMinutes} 分にしました`;
  $('msg').textContent = `持ち時間の上限を ${r.maxMinutes} 分にしました`;
});

$('saveOk').onclick = guard('保存', doSave);
$('saveCancel').onclick = guard('保存をやめる', closeSaveBar);
$('saveName').onkeydown = (e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') closeSaveBar(); };
$('savedReload').onclick = guard('一覧の読み直し', loadSavedList);

/**
 * 起動時にやること。
 *
 * **ここに並べる順番が意味を持つ。** 設定（持ち時間の上限）は入力欄の上限に効くので先に。
 * 保存の一覧は曲が 1 曲も無くても出す（前に作ったセトリは DB の状態と関係なく呼べる）。
 * 空解きは曲があるときだけ投げる（無ければ必ず失敗し、本当の理由が埋もれる）。
 */
async function init() {
  await loadSettings();
  await loadSavedList();
  if (await checkDb()) await loadGroups();
}

init();
