// docs/FEATURE_SPEC.md の型表現。SPEC が権威、ここは写し。

export const ANALYZER_VERSION = '0.5.0';

export const SR_MODEL = 16000;
export const SR_DSP = 44100;
export const EXCERPT_SEC = 60;                    // 解析に使う長さ。v0.5.0 で 60 秒連続に戻した
export const WINDOW_SEC = 20;                     // v0.3.0 の遺物。v0.5.0 では未使用
export const WINDOW_POS = [0.25, 0.5, 0.75];      // v0.3.0 の遺物。v0.5.0 では未使用

// --- v0.5.0: 走査して 60 秒の置き場所を選ぶ ---
// v0.3.0 は 20 秒 x 3 窓にしたが Gate 2 の分離度が 0.34 -> 0.25 に落ちた。
// 20 秒だと拍が 128 -> 42 に減り、16 分グリッドの各マスが荒れるため。
// v0.5.0 は 60 秒の連続区間に戻し、「どこを取るか」だけを賢くする。
export const SCAN_START_FRAC = 0.15;              // 走査開始位置（イントロを避ける）
export const SCAN_SPAN_FRAC = 0.70;               // 走査する長さ（曲全体に対する割合）
export const SCAN_MAX_SEC = 180;                  // 走査の上限。長い曲でデコードが膨らまないように
export const WINDOW_HOP_SEC = 10;                 // 60 秒窓をずらす刻み

export const ONSET_CURVE_LEN = 1024;
export const BAND_CURVE_LEN = 512;   // 帯域別 novelty 曲線の固定長（4 帯域ぶん保存する）
export const GRID_STEPS = 16;
export const GRID_BANDS: [number, number][] = [[0, 250], [250, 1000], [1000, 4000], [4000, 22050]];
export const EMBEDDING_DIM = 200;
export const TAGGRAM_DIM = 50;

// --- 曲まるごとの起伏（envelope）。ANALYZER_VERSION とは独立に版を持つ ---
//
// **なぜ別立てなのか**: 上の特徴量はすべて 60 秒窓の中の値で、しかもその窓は
// 「低域エネルギーが最大の 60 秒」= キックが一番安定して鳴っている所として選んでいる。
// ビルドアップ（低域が抜けたまま全体が上がり続け、最後に一気に戻る）は
// **構造的に窓の外**にあるので、既存の特徴量からは原理的に判定できない。
// 曲全体の音量の起伏だけを別パスで取る。既存の特徴量は一切触らないので
// ANALYZER_VERSION は上げない（上げると 3970 曲の再解析 3 時間が発生してしまう）。
export const ENVELOPE_VERSION = '1.0.0';
export const ENV_POINTS = 512;        // 曲長によらず固定。3 分曲で 0.35 秒/点、8 分曲で 0.94 秒/点
export const ENV_SR = 11025;          // 起伏を見るだけなので低くてよい（デコードが速い）
export const ENV_LOW_HZ = 250;        // GRID_BANDS の最低域と同じ切り方に揃える

/** 曲まるごとの起伏。**生の値だけを持つ。「強い/弱い」の判定は solver 側** (Hard Constraint 3) */
export interface Envelope {
  duration: number;
  rms: Float32Array;   // ENV_POINTS。全帯域の音量
  low: Float32Array;   // ENV_POINTS。0-ENV_LOW_HZ の音量（キックが抜けているかが分かる）
}

/** rekordbox XML の 1 曲 */
export interface XmlTrack {
  trackId: string;
  title: string;
  artist: string;
  genre: string;
  xmlBpm: number | null;
  xmlKey: string;
  /** XML の Size 属性。join key の片割れ。実ファイルサイズではない */
  size: number;
  /** ファイル名のみ。join key の片割れ */
  basename: string;
  /** デコード済みの絶対パス（--audio-root 適用後） */
  path: string;
  /** XML の TotalTime（秒）。実測は decode 時に上書き */
  totalTime: number | null;
}

export interface Features {
  duration: number;
  /** 採用した 60 秒の開始位置（秒。曲頭から）。v0.3.0 の windowUsed(窓番号) とは別物なので列も分けてある */
  windowStart: number;
  /** 走査した各候補位置の低域エネルギー。どこを避けたかの診断用 */
  windowActivity: Float32Array;

  bpmMeasured: number;
  bpmConfidence: number;
  beatCount: number;

  key: string;
  scale: string;
  keyStrength: number;

  rms: number;
  spectralCentroid: number;
  flux: number;
  lowEnergyRatio: number;
  zcr: number;
  danceabilityDsp: number;

  valence: number;
  arousal: number;
  danceabilityMl: number;
  /** softmax の手前。softmax は全曲 0.99-1.00 に飽和して使えないため、こちらを solver が使う */
  danceabilityLogit: number;

  onsetCurve: Float32Array;  // ONSET_CURVE_LEN
  bandCurves: Float32Array;  // GRID_BANDS.length * BAND_CURVE_LEN
  onsetGrid: Float32Array;   // GRID_BANDS.length * GRID_STEPS
  beatTicks: Float32Array;
  mfccMean: Float32Array;    // 13
  mfccVar: Float32Array;     // 13
  embedding: Float32Array;   // EMBEDDING_DIM
  taggram: Float32Array;     // TAGGRAM_DIM
}

export type JobResult =
  | { ok: true; track: XmlTrack; features: Features; ms: number }
  | { ok: false; track: XmlTrack; status: 'error' | 'skipped'; error: string; ms: number };
