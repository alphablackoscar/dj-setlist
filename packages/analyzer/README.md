# analyzer — 音源から生の特徴量を取り出す

**Windows で実行する。** Mac では実行しない（音源が Windows にしかないため）。
仕様は `docs/FEATURE_SPEC.md` が権威。このファイルは使い方だけ。

## 必要なもの

| | |
|---|---|
| Node.js | **22.18 以上**（24.x LTS 推奨）。TypeScript をそのまま実行するため |
| ffmpeg / ffprobe | PATH 上にあること。`winget install Gyan.FFmpeg` |
| ビルドツール | **不要**。ネイティブビルドする依存を入れていない |

```
cd packages/analyzer
npm install
node src/index.ts --check      # 環境確認だけして終了
```

`--check` が通れば準備完了。

## 実行

```
# 試運転（50 曲だけ）
node src/index.ts --xml ../../data/collection.xml --db ../../data/features.db --limit 50

# 本番（全曲。一晩）
node src/index.ts --xml ../../data/collection.xml --db ../../data/features.db --workers 4

# 曲を指定して解析（1 行 1 ファイル名のテキストを渡す。S2 の対照 50 曲用）
node src/index.ts --only ../../config/s2_tracks.txt
```

## オプション

| オプション | 既定 | 説明 |
|---|---|---|
| `--xml <path>` | `data/collection.xml` | rekordbox のコレクション XML |
| `--db <path>` | `data/features.db` | 出力先。無ければ作る |
| `--limit <n>` | なし | 先頭 n 曲だけ。試運転用 |
| `--workers <n>` | CPU 数-1（最大 4） | 並列数。1 曲 ≈ 10 秒なので 4 並列で約 2.5 秒/曲 |
| `--only <file>` | なし | ファイル名リストで絞り込む |
| `--audio-root <path>` | なし | XML 内のルートを実フォルダに読み替える（引っ越し対応） |
| `--audio-root-from <path>` | なし | 読み替え元。省略時は XML の値をそのまま使う |
| `--force` | off | 解析済みでもやり直す |
| `--refresh-meta` | off | **音を解析し直さず、XML のメタデータだけ DB に反映して終わる**（下記） |
| `--check` | off | 環境確認だけして終了 |

## あとから rekordbox でジャンルを直したとき（`--refresh-meta`）

通常の実行は**解析済みの曲を飛ばす**。したがって、あとから rekordbox で
ジャンル欄を埋めても `features.db` は古いままになる。

```
node src/index.ts --xml ../../data/collection.xml --refresh-meta
```

XML から来る列（曲名・アーティスト・ジャンル・BPM・キー・TrackID）だけを上書きする。
**音は解析し直さない**ので 3961 曲でも数秒で終わる。特徴量と `analyzer_version` は変わらない。

手順: rekordbox でジャンルを直す → XML を書き出す → 上のコマンド → commit。

## 途中で止まったら

**同じコマンドをもう一度実行するだけ。** 解析済みの曲は自動でスキップされる。
1 曲ごとに DB へ書いているので、電源が落ちても直前までは残る。

```
再開: 1832 曲は解析済みのためスキップ
対象 2129 曲 / ワーカー 4 個
```

## 終わったら Mac に返す

```
cd ../..
git add data/features.db
git commit -m "features.db: 本番 3961 曲"
git push
```

## 出力の見かた

```
[12/50] OK   stand_high_3B_127.mp3    bpm=127.0 key=Bm dance=1.00 val=5.7 aro=6.2 9043ms
[13/50] ERROR broken.mp3              ffmpeg デコード失敗: ...
[14/50] SKIPPED missing.mp3           ファイルが見つかりません: ...
```

- `ERROR` … 解析に失敗。次回実行時に再試行される
- `SKIPPED` … ファイルが見つからない。XML と実ファイルの場所がずれている可能性。`--audio-root` を検討
- 最後に `blob 長:` が出る。`emb 800 / grid 256 / curve 4096 / tag 200` になっていれば正常

## つまずいたら

| 症状 | 対処 |
|---|---|
| `ffmpeg が見つかりません` | コマンドプロンプトを開き直す。それでもダメなら再起動 |
| `モデルが見つかりません` | `vendor/models/` が無い。clone し直す |
| `Unexpected token` などの構文エラー | Node が古い（22.18 未満）。24.x を入れ直す |
| `tfjs backend が wasm になりません` | `@tensorflow/tfjs-node` が混入している。`npm ls` で確認して外す |
| SKIPPED が大量に出る | 音源フォルダの場所が XML と違う。`--audio-root "D:/Music/"` のように指定 |

## 触ってはいけないところ

`docs/FEATURE_SPEC.md` §2 と §4 のパラメータ（ffmpeg 引数・フレームサイズ・ホップ・モデルの入出力名）。
変えると過去の解析結果と比較できなくなる。**変える場合は `src/types.ts` の `ANALYZER_VERSION` を上げること。**
上げると全曲が再解析対象になる（＝また一晩かかる）。
