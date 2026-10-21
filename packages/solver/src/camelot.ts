// Camelot（キーの時計）。rekordbox の Tonality は既に Camelot 表記なのでそれを主に使い、
// essentia の key/scale から導いた値は「照合」にだけ使う。
//
// なぜ照合するか: rekordbox のキー判定は電子音楽で 70-80% 程度の精度（plan.md S5）。
// 外れているキーを信じて隣接を守っても意味がないので、2 つが食い違う曲には KEY_CHECK を立てて
// 人間の確認に回す。捨てはしない。

const MAJOR: Record<string, number> = {
  B: 1, 'F#': 2, Gb: 2, 'C#': 3, Db: 3, 'G#': 4, Ab: 4, 'D#': 5, Eb: 5, 'A#': 6, Bb: 6,
  F: 7, C: 8, G: 9, D: 10, A: 11, E: 12,
};
const MINOR: Record<string, number> = {
  'G#': 1, Ab: 1, 'D#': 2, Eb: 2, 'A#': 3, Bb: 3, F: 4, C: 5, G: 6, D: 7, A: 8, E: 9,
  B: 10, 'F#': 11, Gb: 11, 'C#': 12, Db: 12,
};

export interface Camelot { n: number; letter: 'A' | 'B'; }

/** "5A" / "11B" をパースする。読めなければ null */
export function parseCamelot(s: string | null | undefined): Camelot | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\s*([AaBb])$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 12) return null;
  return { n, letter: m[2].toUpperCase() as 'A' | 'B' };
}

export function formatCamelot(c: Camelot | null): string | null {
  return c ? `${c.n}${c.letter}` : null;
}

/** essentia の key（"F#" など）+ scale（"major"/"minor"）→ Camelot */
export function fromKeyScale(key: string | null, scale: string | null): Camelot | null {
  if (!key || !scale) return null;
  const k = key.trim().replace('♯', '#').replace('♭', 'b');
  const table = scale.trim().toLowerCase().startsWith('min') ? MINOR : MAJOR;
  const n = table[k];
  return n ? { n, letter: table === MINOR ? 'A' : 'B' } : null;
}

/**
 * ミックスの相性。小さいほど繋ぎやすい。
 *   0 = 同じキー
 *   1 = 隣（±1）または平行調（同じ数字の A/B）
 *   2 = +2（エネルギーブースト。使えるが跳ねる）
 *   3 = それ以外（＝ハーモニックには外れている）
 * どちらかが不明なら null（cost は weights.json の "unknown" を使う）
 */
export function camelotDistance(a: Camelot | null, b: Camelot | null): number | null {
  if (!a || !b) return null;
  if (a.n === b.n && a.letter === b.letter) return 0;
  if (a.n === b.n) return 1;                                  // 平行調
  const d = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
  if (a.letter === b.letter) {
    if (d === 1) return 1;
    if (d === 2) return 2;                                    // エネルギーブースト
  }
  return 3;
}
