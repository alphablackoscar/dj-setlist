// solver の型。features.db のスキーマは docs/FEATURE_SPEC.md §3 が権威。
// ここに現れる energy / groove は「導出値」であり DB には保存しない（Project Hard Constraint 3）。

import type { Block } from './blocks.ts';

/** solver が扱う 1 曲。プール構築時に features.db + collection.xml から組み立てる */
export interface SolverTrack {
  size: number;
  basename: string;
  key: string;               // trackKey(size, basename)

  trackId: string | null;    // rekordbox TrackID。XML 出力に必要
  title: string;
  artist: string;
  path: string | null;       // XML の Location（Windows のパス）。M3U 出力に必要
  duration: number;

  /** 版の違い（Original Mix / Extended / Intro など）を落とした曲名。同じ曲の重複判定に使う */
  titleKey: string;
  /** 小文字化したアーティスト名。連続・回数の判定に使う。空文字なら判定しない */
  artistKey: string;
  /** 1 人ずつに分けた名前（feat. の相手も含む）。同じアーティストの回数・連続はこちらで数える */
  artistNames: string[];

  genre: string;             // XML の生の値
  canonical: string;         // genre_map.json の正規化後（空文字 = 未分類）
  family: string | null;     // genre_family.json の 9 分類。未分類は null
  /** family が音色からの推測か（rekordbox のジャンル欄が空だった曲）。表示で本物と区別する */
  familyGuessed: boolean;

  /**
   * **音の群れ（粗い方）。** config/sound_groups.json の中心点のうち一番近いもの。
   * ジャンルのテキストを見ずに音色だけで決まるので、**全曲が必ずどれか 1 つに入る**（空にならない）。
   * セット全体の性格を保つのに使い、ユーザーが選ぶ単位でもある。
   */
  soundGroup: string;
  /**
   * **音の区画（細かい方）。** ブロック(塊)の切れ目を数えるのに使う。
   * 粗い群だと EDM の箱で塊が 1 つになってしまうため、粒度を分けてある
   * （もともと family(9) / canonical(39) を使い分けていたのと同じ理由）。
   */
  soundCell: string;

  /** 採用 BPM。bpm_measured を基本とし、信頼度が低ければ xml_bpm に落とす */
  bpm: number;
  bpmSource: 'measured' | 'xml';
  bpmConfidence: number;

  camelot: string | null;          // rekordbox Tonality（例 "5A"）
  camelotEstimated: string | null; // essentia の key/scale から導出
  keyAgrees: boolean;              // 上 2 つが一致するか

  /** プール内の順位で 0-1 化した合成エネルギー */
  energy: number;
  /** プール内の順位で 0-1 化した縦ノリ度（Gate 2 の低域 4 分周期強度） */
  groove: number;
  /** 生の 4 分周期強度。診断用 */
  grooveRaw: number;

  /** L2 正規化済み embedding（200f）。音色距離に使う */
  timbre: Float32Array;

  /**
   * 解析が「その曲らしい」と判断した位置（秒）。**試聴の頭出しに使う。**
   * イントロから聞かせても曲の性格が分からないため。analyzer 0.5.0 以降で入る。
   */
  windowStart: number | null;

  /**
   * **ドロップの落差(dB)。** 静かなブレイクからドロップまでの音量差。
   * 大きいほど「浅い時間には向かない（うるさくて話せない）」という読み方をする。
   * env_rms/env_low から毎回計算する導出値で、DB には無い（Hard Constraint 3）。
   * **null は「起伏がまだ無い」であって「静か」ではない**。絞り込みでは素通しさせること。
   */
  dropDb: number | null;

  /** exclude_list.json の context_tags。例 ['anime'] */
  contextTags: string[];

  /**
   * アニソンか。ジャンル soundtrack か anime タグのどちらかに当たれば true。
   * **音の群れでは分離できない**ので別に持つ（実測 309 曲）。
   */
  isAnime: boolean;

  /** プール構築時点で付いた注意フラグ */
  flags: string[];

  /**
   * **つなぎ用の曲（`... 100-128 Transition`）。** 曲の途中で BPM が from → to に変わる DJ ツールで、
   * 単体ではかけられない。`null` = 普通の曲。実測 28 曲（2026-10-17）。
   *
   * from/to は **題名から読む**。`xml_bpm` / `bpm_measured` は片側しか出ないか誤検出で当てにならない
   * （実測: 同じ曲で xml 210.04 / 実測 130.3 など）。題名から読めない曲は from/to が null になり、
   * **通常の選出から外れるが ✂ への挿し込みにも使わない**（どこへ繋ぐ曲か分からないため）。
   */
  transition: { from: number | null; to: number | null } | null;
}

/**
 * **✂ の所に挿し込んだつなぎの曲。** 曲数（position）には入れない。
 *
 * なぜ entries に混ぜないか: position は差し替え・曲を足す・保存と呼び出し・自己検査が
 * すべて鍵として使っている。1 曲挿して番号をずらすと、その全部を同時に直すことになる。
 * つなぎは「`afterPosition` 曲目と次の曲の*あいだ*に置く別の層」として持つ。
 */
export interface Bridge {
  /** この曲番のあとに置く（= 塊の切り替わりの直前の曲） */
  afterPosition: number;
  track: SolverTrack;
  /** 題名から読んだ元の BPM */
  from: number;
  to: number;
  /** かけるときのピッチ（0.02 = +2%）。つなぎは 1 曲なので前後に同じ量がかかる */
  pitch: number;
  /** ピッチをかけたあとの実効 BPM。前の曲 → effFrom / effTo → 次の曲 で繋がる */
  effFrom: number;
  effTo: number;
}

/** 入力 JSON（plan.md S5。自然言語レイヤは MVP に含めない） */
export interface SolveRequest {
  anchor?: { artist?: string; title?: string; basename?: string } | null;
  /** アンカーをセットのどこに置くか。既定は 'end'（終曲を決めて逆算する） */
  anchor_position?: 'end' | 'start';
  /**
   * 使いたい曲（basename）。組んだあと、合う位置の 1 曲と入れ替えて混ぜる（wish.ts）。
   * 入らなければ理由を返すだけで、無理には入れない。
   */
  wish?: string[] | null;
  n?: number;
  /** 実効 BPM の許容レンジ（HARD）。set_bpm を使うときは不要 */
  bpm_band?: [number, number];
  /**
   * **セットを回す BPM。これを決めると「そこへピッチで寄せられる曲」から選ぶことになる。**
   *
   * 数値なら一定（例: 129 = 全曲を 129 で回す）。
   * 配列なら区間ごと（例: [{from:1,bpm:126},{from:7,bpm:129}] = 7 曲目から 129 に上げる）。
   * null なら従来どおり「隣どうしが近ければよい」方式。
   *
   * なぜ要るか（2026-08-08 ユーザー指摘）: 従来方式は隣どうしの差しか見ておらず、
   * **各曲を原曲から何%ずらして使うことになるのかを誰も計算していなかった**。
   * 実測セットは 122.0-129.0 を漂っていたが、129 の場面で 122 の曲を使うなら +5.7% になる。
   * セットの BPM を決めれば、その量が確定し、かつ選べる曲が増える（129±5% で 2015 曲）。
   */
  set_bpm?: number | { from: number; bpm: number }[] | null;
  /**
   * **アニソンの扱い。** 音の群れとは別の軸。
   * exclude = 入れない（既定。ナイトクラブ）/ include = 入れる / only = アニソンだけ。
   *
   * 音の群れ（音色）では分離できないため別軸にしてある。実測: g8 の 24% がアニメ系で、
   * J-POP のダンス曲とアニソンのダンス曲は作りが同じなので音では割れない。
   */
  anime?: 'exclude' | 'include' | 'only';
  /**
   * **おまかせの種。** 同じオーダーでも毎回違うセットを出したいときに指定する。
   * 曲ごとに小さな乱数の下駄を履かせるだけで、HARD 制約は一切ゆるめない。
   * 未指定なら毎回同じ結果になる（再現性のため既定はこちら）。
   */
  seed?: number | null;
  /** 終曲の実効 BPM の目安（SOFT。アンカーの倍率選択に使う） */
  end_bpm?: number | null;
  curve?: string;
  /** basename で候補から外す */
  exclude?: string[];
  /**
   * **このセットで使うジャンルを選ぶ（canonical 39 バケット）。**
   * これが主役の絞り込み。null なら「context が外すもの以外すべて」。
   * Electron の UI ではここがチェックボックスになる。
   */
  genres?: string[] | null;
  /** family（9 分類）でまとめて選ぶ近道。genres と併用でき、和になる */
  families?: string[] | null;
  /**
   * **音の群れで選ぶ（config/sound_groups.json の g1..g8）。これが選び方の本命。**
   * ジャンル欄が空の曲にも群は必ず付いているので、**この選び方なら眠る曲が出ない**。
   * genres / families とは別系統の絞り込みで、併用すると AND になる。
   */
  groups?: string[] | null;
  /**
   * ジャンル欄が空の曲を含めるか。既定 true。
   * ライブラリの 34%（1338 曲）が空欄なので、false にすると使える曲が大きく減る。
   */
  include_untagged?: boolean;
  /**
   * **浅い時間向け（カフェ利用の客がいる時間帯）。**
   * ドロップの落差が大きい曲＝静かなブレイクから一気に爆発する曲を外す。
   * 講師の指摘「ビルドアップが強い曲はうるさすぎて客が話せない」に対応する。
   * しきい値は config/venues.json の `calm.max_drop_db`。**講師によって線引きが割れるので
   * 当てにいかず、つまみとして持つ**（--max-drop で数字を直接指定もできる）。
   */
  calm?: boolean;
  /**
   * **この語を含む曲だけを使う。**（例: ["ラブライブ"] でラブライブ縛りのセット）
   * Artist / Name / Album / ファイル名のどこかに含まれれば採用。複数指定は「どれかに当たれば」。
   * 明示的に選んだものが勝つので、指定すると場面(context)の除外は適用しない。
   */
  only?: string[] | null;
  /**
   * 位置を固定する曲。{ "7": "basename.mp3" } の形。
   * 1 曲だけ差し替えたいときに、残りを固定して解き直すために使う。
   */
  fixed?: Record<string, string> | null;
  /** 1 曲目に置くジャンル。canonical(reggae) でも family(world) でもよい。「レゲエから始めて」用 */
  start_genre?: string | null;
  /** 箱。config/venues.json の名前。bpm_band と色(tone)の既定が入る */
  venue?: string;
  /** 持ち時間（分）。曲数に換算する。n を直接指定すればそちらが優先 */
  minutes?: number;
  /** どこでかけるセットか。config/contexts.json の名前。既定は nightclub */
  context?: string;
  /**
   * **長いセット（1-2 時間）。** ジャンル札の塊（3-4 曲）を並べて組む（packages/solver/src/blocks.ts）。
   * venue / bpm_band / set_bpm / groups は使わない（塊ごとに札と BPM が決まる）。
   */
  long?: boolean;
  /** 今日使ってよい札（config/cards.json の id）。無ければ default_on の札 */
  cards?: string[] | null;
  /** 塊の並び。最初の組み立てで決まり、選び直し（--from）ではこれを引き継ぐ */
  plan?: Block[] | null;
}

/** セットに入った 1 曲 */
export interface SetEntry {
  track: SolverTrack;
  position: number;        // 1 始まり
  /** 実際にかける BPM。set_bpm を使うときはセットの BPM そのもの */
  effectiveBpm: number;
  multiplier: number;      // 0.5 / 1 / 2
  /**
   * **原曲からのピッチ量**（0.03 = +3%）。set_bpm を使うときだけ意味がある。
   * 「この曲は +5.7% 上げて使う」と画面に出すための値。
   */
  pitch: number;
  transitionCost: number;  // 直前の曲からの cost（1 曲目は 0）
  flags: string[];         // 遷移で立ったフラグ（MANUAL_CHECK / CUT など）
  /** 長いセットのとき、何番目の塊か（0 始まり） */
  block?: number;
}

export interface SetlistCandidate {
  entries: SetEntry[];
  totalCost: number;
  manualChecks: number;
  /**
   * ✂ の所に挿し込んだつなぎの曲（2026-10-17）。**曲数には入らない。**
   * 表・XML・M3U・画面はこれを entries に織り込んで並べる（export.ts の `walk()`）。
   */
  bridges?: Bridge[];
}
