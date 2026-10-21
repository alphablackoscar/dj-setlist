# @dj-setlist/solver

`features.db` から 13 曲のセットリスト草案を組む。**音源に触らない・ネットワークを使わない・依存パッケージゼロ。**
Node 24 が `.ts` をそのまま実行するのでビルド手順はない。

出てくるのは**草案**であって完成品ではない。講師レビューと手動差し替えの出発点（plan.md S5-S6）。

## 実際のオーダーの受け方

```bash
# 「EDM の箱で 30 分」
node packages/solver/src/cli.ts --venue edm --minutes 30

# 「ロービートの箱で 30 分、レゲエから始めて」
node packages/solver/src/cli.ts --venue lowbeat --minutes 30 --start-genre reggae

# 3 案が出る → 気に入らなければ
node packages/solver/src/cli.ts --from out/setlist_....json --drop 7   # 7 曲目以降を作り直す（1〜6 はそのまま）
node packages/solver/src/cli.ts --from out/setlist_....json --swap 7   # 7 曲目だけ替える（他は動かさない）
```

`--drop` は **1〜6 曲目を確定したまま 7 曲目以降だけを組み直し、後半の違う案を 3 つ出す。**
DJ が頭から固めていく流れそのもの。納得するまで繰り返す。

| 箱 | BPM | 色 |
|---|---|---|
| `lowbeat` | 85-117 | urban / world / broken / pop |
| `pops` | 100-132 | pop / urban / world / four-on-floor |
| `edm` | 124-138 | four-on-floor / techno / trance / hard |

**箱の「色」は縛りではない。** 外れた系統に少し cost が付くだけで、
BPM が揃っていればレゲエが混ざってもよい（実務でそこは問題にならないため）。
厳密に絞りたいときは `--genres` / `--families`（こちらは HARD）を併用する。

持ち時間は **1 曲 2.31 分**で換算する（30 分 → 13 曲 / 60 分 → 26 曲）。
曲の長さの中央値は 4.00 分なので、**曲の長さからは計算できない**。差はミックスで重なる分。

## Long set (1-2 h): `--long`

Added 2026-10-16. Two levels: stage = BPM zone (cut only between zones) / block = 3-4 tracks of one genre card.
Cards + levels + planner costs: `config/cards.json`. Code: `src/blocks.ts`.

```bash
# 1 h, default cards (anime off in nightclub)
node packages/solver/src/cli.ts --long --minutes 60
# choose cards allowed today
node packages/solver/src/cli.ts --long --minutes 60 --cards hiphop,rnb,latin,pop,jpop,anime,house,edm --context anisong
# edit previous result w/o redoing everything (plan kept; untouched blocks fixed track-for-track)
node packages/solver/src/cli.ts --from out/setlist_....json --redo-block 3              # re-pick block 3 tracks
node packages/solver/src/cli.ts --from out/setlist_....json --set-block 3:latin         # change block 3 card
node packages/solver/src/cli.ts --from out/setlist_....json --remove-cards anime        # replace anime blocks only
node packages/solver/src/cli.ts --from out/setlist_....json --redo-block all --keep-blocks 1,2   # re-pick all unlocked
```

- Rule: next block rises max 1 level (1 calm .. 5 peak) -> no lowbeat -> EDM jump. Drop allowed (costs).
- Block BPM = near card's typical tempo (density peak). Gap > 5% vs previous block = cut (✂, CUT flag).
- `--drop` / `--swap` work on long sets too; block plan kept.
- Pre-existing `--venue` mode unchanged (verified: 7 baseline orders; 2 differ only by artist-count fix below).
- Artist count (all modes, 2026-10-16): each named artist counted separately ("A feat. B" counts A and B).
  Long sets (>= 40 tracks) allow 3 per artist.

## 使う

```bash
# ① ライブラリ全体から最良の 13 曲。中身の違う案が 3 つ出る
node packages/solver/src/cli.ts --n 13 --band 124-136

# ② この曲を最後にして組む
node packages/solver/src/cli.ts --anchor "Horse" --n 13 --band 120-150

# ③ ジャンルを絞って組む
node packages/solver/src/cli.ts --genres techno,tech-house,progressive-house --n 13

# ④ ラブライブだけで組む（「〜だけ」の縛り）
node packages/solver/src/cli.ts --only ラブライブ,Aqours --n 13 --band 120-175

# ⑤ 気に入らない 1 曲だけ差し替える（残りは動かさない）
node packages/solver/src/cli.ts --from out/setlist_....json --swap 7

# 中身を見る
node packages/solver/src/cli.ts --list          曲の一覧
node packages/solver/src/cli.ts --list-genres   選べるジャンルと曲数
```

### 案が 3 つ出る仕組み

beam の上位をそのまま並べても中身が 8-9 割同じになる。
**1 案ずつ解き直して、前の案で使った曲に cost を足す**ことで別物にしている。
「いくつか提案してほしい」に応えるには、順位の 2 番目ではなく別の組み立てが要るため。

本番規模（3640 曲）で 3 案あわせて 303ms、**互いに 100% 違う**。
案どうしの離れ具合は `config/weights.json` の `beam.diversity_penalty` で調整する
（上げるほど離れるが、1 案 1 案の質は落ちる）。

### 1 曲だけ差し替える

`--from <前の結果 JSON> --swap <位置>` で、その曲を候補から外し、**残りは位置ごと固定**して
そこだけ埋め直す。前後の BPM とキーに繋がる曲が入る。案は増やさない（残りが固定なので別案は作れない）。

```
差し替え: 7 曲目「夢で夜空を照らしたい / ...」を外して、残り 12 曲は固定のまま埋め直します
   7 同じ星が見たい      星空凛 (飯田里穂)   127.9  9A  ...
```

### 「〜だけ」の縛り（`--only`）

Artist / 曲名 / アルバム / ファイル名のどこかに語が含まれる曲だけを使う。
**明示的に選んでいるので、場面(context)の除外と位置制約は適用しない**
（ラブライブ縛りのセットに「アニメは 5 曲目以降」を課しても組めないため）。

出力は `out/` に 3 種類。

| ファイル | 用途 |
|---|---|
| `setlist_*_N.xml` | rekordbox 用。ファイル > 読み込み > コレクション XML を読み込み → プレイリストに現れる |
| `setlist_*_N.m3u8` | 素の再生リスト。パスは Windows のもの |
| `setlist_*.json` | 全候補の中身。フラグ・エネルギー・cost 込み |

### 主なフラグ

| オプション | 意味 |
|---|---|
| `--request <file>` | 入力 JSON。書式は `requests/example.json` |
| `--anchor <text>` | 締めに置きたい曲をタイトルで探す |
| `--start` | アンカーを 1 曲目にして前向きに組む（既定は終曲から逆算） |
| `--n <int>` | 曲数（既定 13） |
| `--band <lo>-<hi>` | 使ってよい BPM の幅。HARD |
| `--end-bpm <n>` | 終曲の BPM の目安。SOFT |
| `--curve <name>` | `config/curves.json` のプリセット |
| `--groups g1,g2` | **音の群れで選ぶ。これが主役の絞り込み**（漏れる曲が無い） |
| `--list-groups` | 選べる群と曲数を出す。**UI に出す内容そのもの** |
| `--genres a,b` | 使うジャンルを選ぶ（canonical 39）。細かく指定したいとき |
| `--families a,b` | 9 分類でまとめて選ぶ近道 |
| `--list-genres` | 選べるジャンルと曲数を出す |
| `--context <name>` | 場面（nightclub / anisong / practice） |
| `--with-untagged` / `--no-untagged` | ジャンル欄が空の曲を含めるかを明示 |
| `--verbose` | 除外された曲の理由を出す |
| `--only a,b` | この語を含む曲だけ使う。場面の除外を上書きする |
| `--venue <name>` | 箱。BPM 帯と色の既定が入る（lowbeat / pops / edm） |
| `--minutes <n>` | 持ち時間。曲数に換算する |
| `--start-genre <name>` | 1 曲目のジャンル。canonical でも family でもよい |
| `--from <json> --drop <位置>` | **そこから後ろを作り直す**（手前は確定のまま） |
| `--from <json> --swap <位置>` | 前の結果の 1 曲だけ差し替える |
| `--db / --xml / --config / --out` | パスの差し替え |

## このセットで使うものを選ぶ

選び方は 2 系統ある。**本命は「音の群れ」の方。**

### 音の群れで選ぶ（`--groups`）★ こちらが主役

ジャンルのテキストを見ずに、音色だけで全 3944 曲を 8 つに分けたもの
（`config/sound_groups.json`）。**全曲が必ずどれか 1 つに入るので、選択から漏れる曲が無い。**

```bash
# 何が選べるか（曲数・BPM 帯・中身のジャンル内訳つき）。**UI に出す内容そのもの**
node packages/solver/src/cli.ts --list-groups

# ヒップホップと R&B・ラテンで組む
node packages/solver/src/cli.ts --groups g4,g5 --n 13 --band 90-115
```

| id | 名前 | 曲数 | BPM |
|---|---|---|---|
| g1 | 派手めの EDM | 1012 | 124-145 |
| g2 | ハウス | 911 | 124-130 |
| g3 | 生音・間奏（クラブ向きでない） | 74 | 幅広 |
| g4 | R&B・ラテン | 434 | 90-145 |
| g5 | ヒップホップ | 466 | 88-150 |
| g6 | アニソン（歌もの中心） | 225 | 87-172 |
| g7 | 歌ものハウス・洋楽リミックス | 398 | 100-142 |
| g8 | アニソン・ポップの 4 つ打ち | 424 | 106-144 |

**名前は `scripts/s5-solver/sound-group-labels.json` で書き換えてよい。** 表示に出るのはこれだけ。

### テキストのジャンルで選ぶ（`--genres` / `--families`）

細かく指定したいとき用。**rekordbox のジャンル欄が空の 1331 曲（全体の 34%）は
この選び方だと基本的に漏れる**ので、上の `--groups` を先に検討すること。

```bash
node packages/solver/src/cli.ts --list-genres
node packages/solver/src/cli.ts --genres techno,tech-house,progressive-house --n 13 --band 124-134
node packages/solver/src/cli.ts --families four-on-floor
```

| 状況 | ジャンル欄が空の曲 |
|---|---|
| ジャンルを選んでいない | **含める**（選べる曲を減らさないため） |
| ジャンルを選んだ | **含めない**（テクノを選んだのに 1300 曲混ざるのを防ぐ） |
| `--with-untagged` / `--no-untagged` | 明示した方が勝つ |

両方を指定すると **AND**（群にもジャンルにも当てはまる曲だけ）。

## 使いたい曲を混ぜる（`--wish`）

```
node src/cli.ts --venue edm --minutes 30 --wish "曲A.mp3|曲B.mp3"
```

- 値 = basename を `|` 区切り（Windows のファイル名に使えない文字）。画面では「使いたい曲 → ＋ 曲を選ぶ…」。
- 方式 = 後から差し替え（`src/wish.ts`）。ふだん通り組む → 各位置に「その曲を置き、他は全部固定」で解き直す
  → cost の増えが最小の位置の曲と入れ替える。HARD 制約（BPM・アーティスト・塊の札・時間帯）は `--swap` と同じだけ効く。
- 無理には入れない。入らない理由を案ごとに返す（JSON `candidates[].wishes`）:
  BPM が遠い / その札の塊が無い / 前後と繋がらない / 流れが崩れる（cost 増 > `weights.json` の `wish.max_cost_increase`）。
- 締めの曲の位置と、先に入れた wish の位置は入れ替えない。曲数は変わらない。
- `--from`（差し替え・足す・塊の操作）では入れ直さない。入れた曲は固定で残る。
- 指定順に入れる。先の曲が良い位置を取ると、後の曲が入りにくくなることがある。

## どこでかけるセットか（`--context`）

**BPM もキーも合っていて点数が最良でも、その場でかけられない曲がある。**
ナイトクラブでアニソンをかけることはできない。逆にアニソンイベントでは主役になる。
曲そのものの性質ではなく「どこでかけるか」で決まるので、`config/contexts.json` で切り替える。

| context | 既定の扱い | 使える曲（3961 曲中） |
|---|---|---|
| `nightclub`（既定） | ジャンル `soundtrack` を外す + anime / dj-tool タグを外す | **3640 曲** |
| `anisong` | アニメを使う。ただし 5 曲目以降にしか置かない | 3950 曲 |
| `practice` | 検証用。dj-tool のみ外す | 3950 曲 |

**アニメ 310 曲のうち 305 曲はジャンルが `soundtrack`。** つまり `nightclub` の大半は
「soundtrack を選ばない」だけで済んでいる。

`anime` タグが**それでも要る理由**は、残り 3 曲（ラブライブ蓮ノ空など）の**ジャンル欄が空**だから。
ジャンル選択だけでは、空欄を含める設定のときにすり抜ける。タグは網であって主役ではない。

`dj-tool`（rekordbox 付属の練習用ループ 8 曲、`REC001` などの録音）は**どの場面でも外す**。
曲として成立しないため。これが候補に入っていたのは単純な漏れだった。

除外された曲は候補に一切現れない。`--verbose` で内訳が出る。

## 何を守っているか

**HARD（破ったら候補ごと捨てる）**

- 隣り合う曲の実効 BPM が ±6% 以内。x0.5 / x1 / x2 の等価類を使う
- 実効 BPM が `--band` の中
- 場面で使えないタグの曲は候補に出さない（上の `--context`）
- 場面によっては「使えるが N 曲目以降」（`anisong` の anime は 5 曲目以降）
- 同じ曲を 2 回使わない。**同じ曲の別バージョン（Original / Extended / Remix）も 1 回だけ**
- **同じアーティストは 1 セットに 2 曲まで、かつ連続させない**

**SOFT（cost として積む。重みは `config/weights.json`）**

- Camelot 隣接 / 音色距離（embedding の cosine）/ 縦ノリの目標との差 / エネルギーの目標との差 /
  エネルギーの段差 / BPM の振れ幅 / **音の群れの変化** / 倍率を使ったこと

### セットの「性格」

**並べる判断にジャンルのテキストは一切使わない。音の群れで見る。**

> 「その曲が四つ打ちか pops なのかはどうでもいい。大事なのは厳密な定義ではなく
>   セトリを作った時におかしいかどうか」（ユーザー 2026-08-08）

一貫性はセット全体で見る。隣り合う 2 曲だけを比べていた頃は、
`ヒップホップ → ラテン → ハウス → ハードコア → ポップ` のような並びが最良解になっていた（実測）。
安い順に: 同じ群 0 < 別の群 0.4 < セット初出の群 0.7。

**旧 `family_unknown`（ジャンル不明の曲の cost）は削除した。**
音の群れには「不明」が存在しない（全曲が必ずどれかに入る）ので、
「不明な曲だけで 13 曲」という抜け道そのものが消えたため。

結果は表の `音の群れ:` 行で一目で分かる。

```
─── 案 1 ───   音の群れ: 派手めの EDM 13
─── 案 3 ───   音の群れ: ハウス 9 / 歌ものハウス・洋楽リミックス 4
```

### 塊（ブロック）

DJ のセットは「レゲエ 2 曲 → ラテン 3 曲」のように小さい塊の連なり。
**塊の単位は「音の区画」（24 個）**で、粗い群(8)より 1 段細かい
（群だと EDM の箱で塊が 1〜2 個になり切れ目が見えないため）。1 塊 3 曲が目安。

表の `塊:` 行に出る。13 曲なら `1-3-3-3-3` が最適（13 = 4×3 + 1 なので端数が 1 出る）。

性格を自分で指定したいときは `--groups`（音の群れ）、`--genres`（ジャンル）、
`--anchor <曲> --start`（1 曲目を固定）、`--band`（BPM 帯）を使う。

**Camelot が外れていても曲は捨てない。** `MANUAL_CHECK` を立てて人間の確認に回す
（rekordbox のキー判定は電子音楽で 70-80% 程度。外れたキーを信じて隣接を守っても意味がないため）。

解いた後に HARD 制約を自分で検算する。破れていたら `【自己検査 NG】` を出して exit 3。
S6 で重みを触っても制約が壊れないようにするための保険。

## フラグの読み方

| フラグ | 意味 | どうするか |
|---|---|---|
| `MANUAL_CHECK` | その曲に入るところでキーが離れている | 実際に聴いて判断。差し替えるか、キーを直す |
| `KEY_CHECK` | rekordbox と essentia のキー判定が食い違っている | どちらかが外れている。気になる曲だけ確認 |
| `KEY_MISSING` | rekordbox にキーが入っていない | キー制約はその曲では効いていない |
| `BPM_LOW_CONF` | 解析の BPM 信頼度が低い（値は実測のまま） | 大きく外れていないか目視 |
| `BPM_CHECK` | rekordbox と実測が、倍・半を考えても食い違う | どちらかが外れている。使う前に確認 |

## 中身

```
pool.ts    features.db + collection.xml -> 使える曲のリスト。energy / groove をここで作る
groove.ts  縦ノリ度。Gate 2 で確定した「低域の 4 分周期の強さ」
camelot.ts キーの時計。rekordbox の値を主、essentia の推定を照合に使う
score.ts   HARD / SOFT の定義と、位置ごとの目標カーブ
beam.ts    beam search 本体（幅 10 → 上位 3 案）
export.ts  表 / rekordbox XML / M3U
cli.ts     入口
```

## 設計上の約束

- **導出値（energy / groove）は DB に保存しない。** `features.db` にあるのは生の特徴量だけで、
  指標の定義を変えても音源に触らず再計算できる（Project Hard Constraint 3）。
- **`energy` と `groove` はプール内の順位**（0-1）。絞り込みを変えれば値も変わる。絶対値ではない。
- **`danceability_ml`（softmax）は使わない。`danceability_logit` を使う。** softmax は全曲
  0.988-1.000 に張り付いて曲の区別が付かない。モデルの不具合ではなく、収録が全部ダンス音楽なので
  「踊れる」と断言されているだけ。手前の値は 4.4-14.6 に広がっている（analyzer 0.4.0 から）。
- **DB に無い列は黙って無視する。** analyzer のバージョンで列が増えるため、実在する列だけを
  SELECT する。エネルギーの材料が欠けたときは起動時に警告を出す。
- **エネルギーは 1 曲ずつ上げない。** 3-4 曲同じ高さを保ってから段を上げる（`plateau`）。
  1 曲ごとの微増は耳で分からず、上げ幅だけ使い切って後半が詰まるため。
- **倍率（x0.5 / x2）には cost が付く。** 付けないと、BPM 幅を広げたときに全曲 x0.5 の
  「実質ただの等速」セットが最良解として出てくる。
- **BPM は信頼度が低くても実測（`bpm_measured`）を使う。** rekordbox の `AverageBpm` は
  対照 50 曲のうち 4 曲で実測のちょうど 2 倍だった（hip-hop を 200 と表記するなど）。
  XML に落とす方が事故る。XML は実測が無いときの最後の手段。
- **重複制限は HARD に置いてある。** SOFT は「似ているほど cost が低い」ので、制限が無いと
  同じ曲の別バージョンや同じアーティストが並ぶ（4000 曲規模の試験で実際に起きた）。
