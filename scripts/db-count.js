// features.db の status 内訳を JSON で 1 行出すだけの小道具。
//
// **なぜ独立したスクリプトが要るのか（2026-10-03）。**
// 画面（Electron のメインプロセス）が `node:sqlite` を直接 require していたのが
// 「XML を読み込み」が必ず落ちた原因だった。Electron 33 に同梱の Node は 20.18.3 で、
// `node:sqlite` は Node 22.5 で入った組み込みなので **存在しない**。
// require が ERR_UNKNOWN_BUILTIN_MODULE を投げ、曲数が毎回 null になっていた。
//
// solver / analyzer と同じ約束で逃げる: **DB に触る仕事はシステムの Node 24 に渡す。**
// 画面側のプロセスでは node:sqlite を使わない。
//
//   node scripts/db-count.js [--db data/features.db]

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const i = argv.indexOf('--db');
const dbPath = i >= 0 && argv[i + 1] ? argv[i + 1] : 'data/features.db';

if (!existsSync(dbPath)) {
  console.error(`features.db がありません: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT status, COUNT(*) AS n FROM tracks GROUP BY status').all();
db.close();

const by = Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
process.stdout.write(JSON.stringify({
  done: by.done ?? 0,
  skipped: by.skipped ?? 0,
  error: by.error ?? 0,
}) + '\n');
