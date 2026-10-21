// 小節ごとの特徴量から **イントロ終わり / メイン / アウトロ開始** を決める。
//
// 方針（2026-10-17 の実測から）:
//   - 位置は必ず **8 小節グリッドの上**に置く。手打ちＱの間隔は 8 小節が 55.5%、
//     8 の倍数が 68.4%、4 の倍数が 76.3%。人はフレーズの頭にしか打たない。
//   - **位相は音から当てない。rekordbox の小節線そのもの（1 小節目）から 8 小節で数える。**
//     音から当てると 47%、イントロの立ち上がりを錨にすると 1-2 小節ずれて逆に悪化した
//     （イントロの一致 89% → 55%）。ユーザーはグリッドの頭をフレーズの頭に合わせてある。
//   - アウトロは**エネルギーでは出ない**。クラブ用の edit は終わりまでフルで鳴り続けるため、
//     「最後に濃かった所」を探すと中央値 +24 小節ずれる（実測。最初の試作は完全な失敗だった）。
//     **音の中身が変わる所**（自己相似行列の novelty）と**中域（歌）の脱落**で決める。

/** cosine 自己相似の novelty。チェッカーボード核（Foote）。L は片側の小節数 */
export function novelty(bars, L = 16) {
  const n = bars.length, nov = new Float64Array(n);
  const dot = (a, b) => { let v = 0; for (let i = 0; i < a.length; i++) v += a[i] * b[i]; return v; };
  for (let c = 0; c < n; c++) {
    let same = 0, cross = 0, ns = 0, nc = 0;
    for (let i = -L; i < L; i++) {
      const x = c + i; if (x < 0 || x >= n) continue;
      for (let j = -L; j < L; j++) {
        const y = c + j; if (y < 0 || y >= n) continue;
        const s = dot(bars[x].band, bars[y].band);
        if ((i < 0) === (j < 0)) { same += s; ns++; } else { cross += s; nc++; }
      }
    }
    nov[c] = (ns ? same / ns : 0) - (nc ? cross / nc : 0);   // 前後が似ていないほど大きい
  }
  return nov;
}

const mean = (bars, f, a, b) => {
  let v = 0, c = 0;
  for (let i = Math.max(0, a); i < Math.min(bars.length, b); i++) { v += f(bars[i]); c++; }
  return c ? v / c : 0;
};
const pct = (arr, p) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * p)))];
};

/**
 * 3 点を返す。単位は**小節番号**（0 = グリッドの 1 小節目）。
 * `grid` はその曲で使う 8 小節の線（rekordbox の小節線から数える）。
 */
export function detectCues(bars) {
  const N = bars.length;
  if (N < 24) return null;
  const mF = pct(bars.map((b) => b.full), 0.75);
  const mL = pct(bars.map((b) => b.low), 0.75);
  const mM = pct(bars.map((b) => b.mid), 0.75);
  const mH = pct(bars.map((b) => b.high), 0.75);
  const run = (f, i, n) => mean(bars, f, i, i + n);

  const nov0 = novelty(bars, 16);
  const novMax0 = Math.max(...nov0) || 1;

  // --- イントロ終わり: キックと全体が 8 小節続けて立ち上がる最初の所
  // しきい値方式。novelty 方式も試したが、**ドロップ（32-40 小節）を掴んでしまい 77% → 67% に落ちた**
  let intro = 0;
  for (let i = 0; i < N - 8; i++) {
    if (run((b) => b.low, i, 8) >= 0.55 * mL && run((b) => b.full, i, 8) >= 0.55 * mF) { intro = i; break; }
  }
  // **頭からフルで鳴っている曲**では、この規則が 1 小節目で成立してしまい何も言っていない
  // （実測 2026-10-19 `Don't Lose Your Head`: 正解 17 小節に対し 1 小節を返した）。
  // そういう曲のイントロ終わりは**音量ではなく中身の変わり目**なので novelty で取り直す。
  const startsHot = intro <= 2;
  if (startsHot) {
    let best = -Infinity, at = 0;
    for (let i = 8; i < Math.floor(N * 0.45); i += 8) {
      // 8 小節の線の上だけを見る。前半で一番「変わる」所
      if (nov0[i] / novMax0 > best) { best = nov0[i] / novMax0; at = i; }
    }
    intro = at;
  }
  // --- フレーズの線。**rekordbox の小節線そのものを使う**（1 小節目 = グリッドの頭）。
  // ユーザーはグリッドの頭がフレーズの頭になるよう合わせてあり、手打ちＱは 0, 8, 16 … に並ぶ。
  // 音から位相を当てようとすると 47% しか合わず、イントロを錨にすると 1-2 小節ずれて
  // 手打ちと重ならない（実測 2026-10-17: イントロの一致が 89% → 55% に落ちた）。
  // **刻みは 8 小節。** 4 小節にすると線が倍になり、グリッドが手打ちを覆う割合は
  // 60% → 84% に上がるが、**名前付きの 3 点が「手打ちでない線」に吸い寄せられて**
  // イントロ 89% → 68% / メイン 68% → 49% に落ちる（173 曲で実測）。覆いたいなら
  // 名前付きの 3 点とは別に 4 小節の線を出すこと。同じ刻みで兼ねない。
  const STEP = Number(process.env.CUE_STEP ?? 8);
  const grid = [];
  for (let i = 0; i < N - 4; i += STEP) grid.push(i);
  const phase = 0;
  const snap = (i) => grid.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a), grid[0] ?? 0);

  // --- 曲の始まり（イントロの終わり）: イントロ以降で、全体と高域が 8 小節続けて濃くなる最初の所
  //
  // **2026-10-21 に名前を直した。** ここは `main`（メイン）という名前で呼んでいたが、
  // ユーザーの指摘:「あなたの打っているメインは**曲の始まり（イントロの終わり）**であり、
  // そこにもキューは必要だが、それ以外に**メインに盛り上がるパート**を示す必要がある」。
  // **DJ 用語のメイン = 曲が一番盛り上がる部分**（エネルギーが強く、歌が薄い）。別物。
  let songStart = intro;
  for (let i = intro; i < N - 8; i++) {
    if (run((b) => b.full, i, 8) >= 0.85 * mF && run((b) => b.high, i, 8) >= 0.7 * mH) { songStart = i; break; }
  }
  songStart = snap(songStart);

  // --- アウトロ開始: 後半で「中身が変わり、かつ中域（歌）が落ちる」所
  const nov = nov0;
  const novMax = novMax0;
  // 重みは env で振れる（CUE_W_NOV / CUE_W_MID / CUE_W_FULL / CUE_W_POS / CUE_LO / CUE_HI）。
  // scripts/cue/eval.js に食わせて測る。**既定値は 173 曲で振って決めた。**
  // **位置の下駄は実測から**: 手打ちのアウトロは曲の 75% 付近に来る
  //（176 曲で 10% 点 0.57 / 中央 0.75 / 90% 点 0.89。2026-10-17）。
  // 音だけで決めると中央値で 16 小節あとを拾っていた（最後のブレイクや落ちサビを掴む）。
  const W_NOV = Number(process.env.CUE_W_NOV ?? 1.0);
  const W_MID = Number(process.env.CUE_W_MID ?? 1.2);
  const W_FULL = Number(process.env.CUE_W_FULL ?? 0.4);
  const W_POS = Number(process.env.CUE_W_POS ?? 6);
  // 0.82 = **最後のＱ（= アウトロの起点）** の位置。本人の打ち方を聞いて正解を
  // 「最後のかたまりの先頭(0.75)」から「最後のＱ」に直したときに測り直した値（2026-10-17）。
  const POS_AT = Number(process.env.CUE_POS_AT ?? 0.82);
  const LO = Number(process.env.CUE_LO ?? 0.5), HI = Number(process.env.CUE_HI ?? 0.92);
  let outro = grid.length ? grid[grid.length - 1] : N - 8, best = -Infinity;
  for (const i of grid) {
    if (i < N * LO || i > N * HI || i > N - 8) continue;
    const midDrop = (mean(bars, (b) => b.mid, i - 16, i) - mean(bars, (b) => b.mid, i, i + 16)) / (mM || 1);
    const fullDrop = (mean(bars, (b) => b.full, i - 16, i) - mean(bars, (b) => b.full, i, i + 16)) / (mF || 1);
    const v = W_NOV * (nov[i] / novMax) + W_MID * midDrop + W_FULL * fullDrop
      - W_POS * Math.abs(i / N - POS_AT);
    if (v > best) { best = v; outro = i; }
  }

  // --- **メイン（盛り上がり）**: 2026-10-21 追加。ここが本当の「メイン」。
  //
  // 定義（ユーザー）: **エネルギーが強く、通常は歌があまりない**部分。
  // 探し方: 8 小節の枠ごとに「低域 + 全体が濃く、中域（歌）が相対的に薄い」点数を出し、
  // 一番高い枠から**両側に伸ばせるだけ伸ばす**（点数が山の 7 割を保てる間）。
  // 伸ばした長さがそのまま**「8 小節が何個分か」**になる。
  //
  // 本人の流儀の実測（189 曲 1512 個。`scripts/cue/style.js`）:
  //   1 曲あたり **8 個**（中央値）/ 隣り合う間隔の **50.2% がちょうど 8 小節** /
  //   8 小節の連は 1 曲あたり **2.02 本**、長さは **2 本 51% / 3 本 33% / 4 本 11%**。
  // → **盛り上がりの中を 8 小節ごとに刻むのが本人の打ち方。** 5 点しか出していなかったのは足りない。
  const W_LOW = Number(process.env.CUE_M_LOW ?? 1.0);
  const W_FULL2 = Number(process.env.CUE_M_FULL ?? 1.0);
  const W_VOX = Number(process.env.CUE_M_VOX ?? 0.6);     // 歌（中域）が濃いほど減点
  const blockScore = (i) =>
    W_LOW * (run((b) => b.low, i, 8) / (mL || 1))
    + W_FULL2 * (run((b) => b.full, i, 8) / (mF || 1))
    - W_VOX * (run((b) => b.mid, i, 8) / (mM || 1));
  // **探すのは「曲が始まってから、アウトロに入る前まで」。**
  // アウトロを先に決めてからここに来るのはそのため（2026-10-21 に順序を入れ替えた）。
  // 範囲を切らないと、終盤の一番濃い所を掴んで**アウトロの位置にメインを立てる**
  // （実測: Don't Lose Your Head で 105 小節 = 本人のアウトロと同じ所に出た）。
  const blocks = [];
  const mainTo = Math.min(outro, N - 8);
  for (let i = Math.max(songStart, 8); i + 8 <= mainTo; i += 8) blocks.push({ i, v: blockScore(i) });
  let main = songStart, mainEnd = Math.min(songStart + 16, N - 1), mainBars = 0;
  if (blocks.length) {
    let top = 0;
    for (let k = 1; k < blocks.length; k++) if (blocks[k].v > blocks[top].v) top = k;
    const KEEP = Number(process.env.CUE_M_KEEP ?? 0.7) * blocks[top].v;
    let a = top, b = top;
    while (a - 1 >= 0 && blocks[a - 1].v >= KEEP) a--;
    while (b + 1 < blocks.length && blocks[b + 1].v >= KEEP) b++;
    // **長さに上限を置く。** 置かないと「終わりまでずっとメイン」になって何も言っていない
    const MAXB = Number(process.env.CUE_M_MAX ?? 4);      // 8 小節 x 4 = 32 小節まで
    if (b - a + 1 > MAXB) {
      // 山を中心に残す
      a = Math.max(a, top - Math.floor((MAXB - 1) / 2));
      b = Math.min(b, a + MAXB - 1);
      a = Math.max(0, b - MAXB + 1);
    }
    main = blocks[a].i;
    mainBars = b - a + 1;                                  // 8 小節が何個分か
    mainEnd = Math.min(blocks[b].i + 8, N - 1);
  }
  // **メインは曲の始まりより後ろ。** 同じ所に 2 本立てても意味がない
  if (main <= songStart) { main = Math.min(songStart + 8, N - 9); mainEnd = Math.min(main + 16, N - 1); mainBars = Math.max(1, mainBars); }
  /** メインの中の 8 小節線（開始と終わりの間）。**何個分かを目で数えられるようにする** */
  const mainSteps = [];
  for (let i = main + 8; i < mainEnd; i += 8) mainSteps.push(i);

  return {
    intro: snap(intro),
    // **曲の始まり（イントロの終わり）。** 2026-10-21 までこれを `main` と呼んでいた
    songStart,
    // **メイン = 盛り上がり**（エネルギーが強く歌が薄い所）。`mainBars` = 8 小節が何個分か
    main, mainEnd, mainBars, mainSteps,
    outro, phase, grid, n: N,
  };
}
