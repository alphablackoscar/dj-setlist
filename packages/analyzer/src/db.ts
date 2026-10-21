// features.db。組み込みの node:sqlite を使う（ネイティブビルドを要求しないため）。
// スキーマは docs/FEATURE_SPEC.md §3 が権威。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ANALYZER_VERSION, ENVELOPE_VERSION, type Envelope, type Features, type XmlTrack } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  size              INTEGER NOT NULL,
  basename          TEXT    NOT NULL,
  track_id          TEXT,
  title             TEXT,
  artist            TEXT,
  genre             TEXT,
  xml_bpm           REAL,
  xml_key           TEXT,
  duration          REAL,
  window_used       INTEGER,   -- v0.3.0 の窓番号(0/1/2)。v0.5.0 以降は書かない
  window_start      REAL,       -- v0.5.0: 解析に使った 60 秒の開始位置（秒。曲頭から）
  window_activity   BLOB,
  status            TEXT    NOT NULL,
  error             TEXT,
  analyzer_version  TEXT    NOT NULL,
  analyzed_at       TEXT    NOT NULL,
  bpm_measured      REAL,
  bpm_confidence    REAL,
  beat_count        INTEGER,
  key               TEXT,
  scale             TEXT,
  key_strength      REAL,
  rms               REAL,
  spectral_centroid REAL,
  flux              REAL,
  low_energy_ratio  REAL,
  zcr               REAL,
  danceability_dsp  REAL,
  valence           REAL,
  arousal           REAL,
  danceability_ml   REAL,
  danceability_logit REAL,
  onset_curve       BLOB,
  band_curves       BLOB,
  onset_grid        BLOB,
  beat_ticks        BLOB,
  mfcc_mean         BLOB,
  mfcc_var          BLOB,
  embedding         BLOB,
  taggram           BLOB,
  -- 曲まるごとの起伏（別パス。ANALYZER_VERSION とは独立）。FEATURE_SPEC §4.7
  env_version       TEXT,
  env_rms           BLOB,       -- ENV_POINTS f32  全帯域の音量
  env_low           BLOB,       -- ENV_POINTS f32  0-250Hz の音量
  PRIMARY KEY (size, basename)
);
CREATE INDEX IF NOT EXISTS idx_status ON tracks(status);
CREATE TABLE IF NOT EXISTS runs (
  started_at        TEXT NOT NULL,
  analyzer_version  TEXT NOT NULL,
  note              TEXT
);
`;

const COLUMNS = [
  'size', 'basename', 'track_id', 'title', 'artist', 'genre', 'xml_bpm', 'xml_key', 'duration', 'window_used', 'window_start', 'window_activity',
  'status', 'error', 'analyzer_version', 'analyzed_at',
  'bpm_measured', 'bpm_confidence', 'beat_count', 'key', 'scale', 'key_strength',
  'rms', 'spectral_centroid', 'flux', 'low_energy_ratio', 'zcr', 'danceability_dsp',
  'valence', 'arousal', 'danceability_ml', 'danceability_logit',
  'onset_curve', 'band_curves', 'onset_grid', 'beat_ticks', 'mfcc_mean', 'mfcc_var', 'embedding', 'taggram',
];

// **env_* は COLUMNS に入れない。** COLUMNS は upsert が全列を上書きするための一覧なので、
// ここに入れると通常の解析を走らせるたびに起伏が NULL で潰れる。
// 起伏は別パス（--envelope）が専用の UPDATE で書く。COLUMN_TYPES には入れること（migrate が見る）。

/** migrate() が参照する列定義。SCHEMA と必ず一致させること */
const COLUMN_TYPES: Record<string, string> = {
  env_version: 'TEXT', env_rms: 'BLOB', env_low: 'BLOB',
  track_id: 'TEXT', title: 'TEXT', artist: 'TEXT', genre: 'TEXT', xml_bpm: 'REAL', xml_key: 'TEXT',
  duration: 'REAL', window_used: 'INTEGER', window_start: 'REAL', window_activity: 'BLOB', error: 'TEXT', bpm_measured: 'REAL', bpm_confidence: 'REAL', beat_count: 'INTEGER',
  key: 'TEXT', scale: 'TEXT', key_strength: 'REAL', rms: 'REAL', spectral_centroid: 'REAL', flux: 'REAL',
  low_energy_ratio: 'REAL', zcr: 'REAL', danceability_dsp: 'REAL', valence: 'REAL', arousal: 'REAL',
  danceability_ml: 'REAL', danceability_logit: 'REAL', onset_curve: 'BLOB', band_curves: 'BLOB', onset_grid: 'BLOB',
  beat_ticks: 'BLOB', mfcc_mean: 'BLOB', mfcc_var: 'BLOB', embedding: 'BLOB', taggram: 'BLOB',
};

function blob(a: Float32Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

/** 再開判定に使う key。DB 側と XML 側で必ずこの関数を通すこと（表記ゆれで再解析が起きる） */
export function trackKey(size: number, basename: string): string {
  return String(size) + '|' + basename;
}

export class FeatureStore {
  private db: DatabaseSync;
  private upsert: any;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.migrate();   // 既存 DB に列を足す。CREATE TABLE IF NOT EXISTS は ALTER しないため
    const placeholders = COLUMNS.map(() => '?').join(', ');
    const updates = COLUMNS.filter((c) => c !== 'size' && c !== 'basename').map((c) => `${c} = excluded.${c}`).join(', ');
    this.upsert = this.db.prepare(
      `INSERT INTO tracks (${COLUMNS.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(size, basename) DO UPDATE SET ${updates}`);
  }

  /**
   * 既存 DB のスキーマを現行に合わせる。
   * CREATE TABLE IF NOT EXISTS は既存テーブルを変更しないので、列を足したときに
   * 「table tracks has no column named X」で落ちる。3961 曲の DB を作り直すのは
   * 3 時間の損失になるため、足りない列は自動で ALTER する。
   */
  private migrate(): void {
    const existing = new Set((this.db.prepare('PRAGMA table_info(tracks)').all() as any[]).map((r) => String(r.name)));
    const added: string[] = [];
    for (const [col, type] of Object.entries(COLUMN_TYPES)) {
      if (!existing.has(col)) { this.db.exec(`ALTER TABLE tracks ADD COLUMN ${col} ${type}`); added.push(col); }
    }
    if (added.length) console.log(`DB スキーマを更新しました: ${added.join(', ')} を追加`);
  }

  startRun(note: string): void {
    this.db.prepare('INSERT INTO runs (started_at, analyzer_version, note) VALUES (?, ?, ?)')
      .run(new Date().toISOString(), ANALYZER_VERSION, note);
  }

  /** 現行 analyzer_version で done 済みの key 集合。再開時にスキップする対象 */
  doneKeys(): Set<string> {
    const rows = this.db.prepare(
      "SELECT size, basename FROM tracks WHERE status = 'done' AND analyzer_version = ?").all(ANALYZER_VERSION) as any[];
    return new Set(rows.map((r) => trackKey(Number(r.size), String(r.basename))));
  }

  /**
   * **音を解析し直さずに、XML 側のメタデータ（曲名・アーティスト・ジャンル・BPM・キー）だけを上書きする。**
   *
   * なぜ要るか: 通常の実行は `status='done'` の曲を丸ごと飛ばす。したがって
   * **あとから rekordbox でジャンル欄を埋めても features.db は古いまま**になる。
   * 空欄のジャンルを少しずつ埋めていく運用をすると必ずぶつかる。
   *
   * 更新するのは XML から来る列だけ。**解析結果（特徴量・analyzer_version）には触らない。**
   * したがって解析のやり直しは発生しない（3961 曲でも数秒で終わる）。
   *
   * @returns 実際に値が変わった曲数
   */
  refreshMeta(tracks: XmlTrack[]): { updated: number; notFound: number } {
    const sel = this.db.prepare(
      'SELECT title, artist, genre, xml_bpm, xml_key, track_id FROM tracks WHERE size = ? AND basename = ?');
    const upd = this.db.prepare(
      `UPDATE tracks SET track_id = ?, title = ?, artist = ?, genre = ?, xml_bpm = ?, xml_key = ?
       WHERE size = ? AND basename = ?`);
    let updated = 0, notFound = 0;
    const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
    for (const t of tracks) {
      const cur = sel.get(t.size, t.basename) as any;
      if (!cur) { notFound++; continue; }
      if (same(cur.title, t.title) && same(cur.artist, t.artist) && same(cur.genre, t.genre)
          && same(cur.xml_bpm, t.xmlBpm) && same(cur.xml_key, t.xmlKey) && same(cur.track_id, t.trackId)) continue;
      upd.run(t.trackId, t.title, t.artist, t.genre, t.xmlBpm, t.xmlKey, t.size, t.basename);
      updated++;
    }
    return { updated, notFound };
  }

  /**
   * 起伏をまだ持っていない曲を返す（--envelope の対象）。
   * `status='done'` に限るのは、それ以外は実ファイルが無い曲（skipped 15 曲）だから。
   * `--force` 相当は呼び出し側で all=true にして全件返させる。
   */
  envelopeTargets(all: boolean): { size: number; basename: string }[] {
    const where = all
      ? "status = 'done'"
      : `status = 'done' AND (env_rms IS NULL OR env_version IS NOT ?)`;
    const stmt = this.db.prepare(`SELECT size, basename FROM tracks WHERE ${where}`);
    const rows = (all ? stmt.all() : stmt.all(ENVELOPE_VERSION)) as any[];
    return rows.map((r) => ({ size: Number(r.size), basename: String(r.basename) }));
  }

  /** 起伏だけを書く。**既存の特徴量と analyzer_version には一切触らない** */
  saveEnvelope(size: number, basename: string, e: Envelope): void {
    this.db.prepare(
      'UPDATE tracks SET env_version = ?, env_rms = ?, env_low = ? WHERE size = ? AND basename = ?')
      .run(ENVELOPE_VERSION, blob(e.rms), blob(e.low), size, basename);
  }

  /** 起伏の受け入れ確認 */
  envelopeSummary(): any {
    return this.db.prepare(`
      SELECT COUNT(*) AS n,
             MIN(length(env_rms)) AS rms_min, MAX(length(env_rms)) AS rms_max,
             MIN(length(env_low)) AS low_min, MAX(length(env_low)) AS low_max
      FROM tracks WHERE env_rms IS NOT NULL`).get();
  }

  saveOk(t: XmlTrack, f: Features): void {
    this.upsert.run(
      t.size, t.basename, t.trackId, t.title, t.artist, t.genre, t.xmlBpm, t.xmlKey, f.duration, null, f.windowStart, blob(f.windowActivity),
      'done', null, ANALYZER_VERSION, new Date().toISOString(),
      f.bpmMeasured, f.bpmConfidence, f.beatCount, f.key, f.scale, f.keyStrength,
      f.rms, f.spectralCentroid, f.flux, f.lowEnergyRatio, f.zcr, f.danceabilityDsp,
      f.valence, f.arousal, f.danceabilityMl, f.danceabilityLogit,
      blob(f.onsetCurve), blob(f.bandCurves), blob(f.onsetGrid), blob(f.beatTicks),
      blob(f.mfccMean), blob(f.mfccVar), blob(f.embedding), blob(f.taggram));
  }

  saveFail(t: XmlTrack, status: 'error' | 'skipped', error: string): void {
    this.upsert.run(
      t.size, t.basename, t.trackId, t.title, t.artist, t.genre, t.xmlBpm, t.xmlKey, null, null, null, null,
      status, error.slice(0, 500), ANALYZER_VERSION, new Date().toISOString(),
      null, null, null, null, null, null,
      null, null, null, null, null, null,
      null, null, null, null,
      null, null, null, null, null, null, null, null);
  }

  summary(): { status: string; n: number }[] {
    return this.db.prepare('SELECT status, COUNT(*) AS n FROM tracks GROUP BY status').all() as any[];
  }

  /** 受け入れ確認用（FEATURE_SPEC §7） */
  blobLengths(): any {
    return this.db.prepare(`
      SELECT COUNT(*) AS n,
             MIN(length(embedding))   AS emb_min,  MAX(length(embedding))   AS emb_max,
             MIN(length(onset_grid))  AS grid_min, MAX(length(onset_grid))  AS grid_max,
             MIN(length(onset_curve)) AS cur_min,  MAX(length(onset_curve)) AS cur_max,
             MIN(length(taggram))     AS tag_min,  MAX(length(taggram))     AS tag_max,
             MIN(length(band_curves)) AS band_min, MAX(length(band_curves)) AS band_max
      FROM tracks WHERE status = 'done'`).get();
  }

  close(): void { this.db.close(); }
}
