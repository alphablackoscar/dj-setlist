# vendor/models — 同梱済み TensorFlow.js モデル

**実行時にダウンロードしない。** ここにあるものを読む。

## なぜ同梱するのか

配布元 `https://essentia.upf.edu/models/autotagging/msd/msd-musicnn-1-tfjs.zip` は
**アーカイブが壊れていて展開できない**（`msd-vgg-1-tfjs.zip` も同様。系統的）。
ここに置いてあるのは essentia.js リポジトリに実体で同梱されていた無傷のコピー。
詳細は `docs/DECISIONS.md` の「Gate 0 追記」。

副次的な効果として、プロジェクトの「ゼロネットワーク」制約を自動的に満たす。

## 中身

| ディレクトリ | 役割 | 入力 | 出力 |
|---|---|---|---|
| `msd-musicnn-1/` | 埋め込み + オートタグ | mel patch `[-1,187,96]` (16kHz) | `model/dense/Relu` = **200次元 embedding** / `model/Sigmoid` = 50 tags |
| `danceability-msd-musicnn-1/` | ダンス性ヘッド | embedding `[-1,200]` | `model/Softmax` |
| `emomusic-msd-musicnn-1/` | valence / arousal ヘッド | embedding `[-1,1,200]` | `dense_out` = [valence, arousal] |

## 取得元

```
https://raw.githubusercontent.com/MTG/essentia.js/master/examples/starter-code/autotagging/models/msd-musicnn-1/
https://essentia.upf.edu/models/classification-heads/danceability/danceability-msd-musicnn-1-tfjs/
https://essentia.upf.edu/models/classification-heads/emomusic/emomusic-musicnn-msd-1-tfjs/
```
ヘッド 2 種は配布元から正常に取得できる（壊れているのは embedding 側の zip のみ）。

## SHA-256（改変検知用）

```
2df238355538b680e70f06e30fb04df52f133da6ea1915530ec8c590da073762  msd-musicnn-1/model.json
7ebfb970c7389b6276ffc34f0d7fc80ba2765e5310829f3618ad5b977326667d  msd-musicnn-1/group1-shard1of1.bin
df0815d27e284c5104b08d567ce6eed5fd51c3c923b27021e12049f8381d3ab9  danceability-msd-musicnn-1/model.json
fa252d21a45a569094fa41b806a9af5b638bf96c7f3d263e7f9bca5d7eed7ac0  danceability-msd-musicnn-1/group1-shard1of1.bin
111e676b8a7a7127eba9486f3966587ea23f0ba691f82aa6b0b3a5e29c9bda5b  emomusic-msd-musicnn-1/model.json
597be14f6376fcb557164f9d0aac30b718067e961a1fd1207e1f883b5bce36d6  emomusic-msd-musicnn-1/group1-shard1of1.bin
```

検証: `shasum -a 256 -c` 相当を CI / 受け入れ時に回すこと。`analyzer_version` を上げる前に必ず確認する。

## 使うときの注意

- `@tensorflow/tfjs-node` は使わない（Node 24 で動かない）。`@tensorflow/tfjs-backend-wasm` を明示指定する。
- musicnn は placeholder が 2 つ。`model/Placeholder_1`（DT_BOOL）に `false` を渡す。
- モデル入力は 16kHz。onset 系は 44.1kHz。デコードを 2 系統持つこと。
