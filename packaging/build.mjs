// Build the macOS (Apple Silicon) .dmg.   cd packaging && npm install && npm run build
//
// Steps:
//   1. bin/ffmpeg + bin/ffprobe  (build-ffmpeg.sh, LGPL, own build)
//   2. bin/node                  (official Node arm64, SHA256 checked vs nodejs.org SHASUMS256.txt)
//   3. stage/                    repo-shaped copy of what the app runs (spawned node needs real files -> asar off)
//   4. electron-builder          -> dist/*.dmg, ad-hoc signed (no Apple Developer yet)
// Layout inside .app: Resources/app = stage (ROOT for main.js), Resources/bin = node/ffmpeg/ffprobe.
// packages/app/paths.js puts Resources/bin first on PATH and moves data to ~/Library/Application Support.
// Network is used at BUILD time only (downloads). The app itself stays offline (constraint 1).

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const NODE_VER = 'v24.10.0';   // same as dev machines (.claude/CLAUDE.md Prerequisites)
const BIN = join(HERE, 'bin');
const STAGE = join(HERE, 'stage');
const CACHE = join(HERE, '.cache');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// 1. ffmpeg / ffprobe
sh(join(HERE, 'build-ffmpeg.sh'), []);

// 2. node
async function fetchNode() {
  if (existsSync(join(BIN, 'node'))) return;
  mkdirSync(CACHE, { recursive: true });
  const name = `node-${NODE_VER}-darwin-arm64.tar.gz`;
  const tgz = join(CACHE, name);
  const base = `https://nodejs.org/dist/${NODE_VER}`;
  if (!existsSync(tgz)) {
    const r = await fetch(`${base}/${name}`);
    if (!r.ok) throw new Error(`download ${name}: ${r.status}`);
    writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
  }
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.endsWith('  ' + name))?.split(' ')[0];
  const got = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  if (!want || want !== got) throw new Error(`node SHA256 mismatch: want ${want} got ${got}`);
  sh('tar', ['-xzf', tgz, '-C', CACHE, `node-${NODE_VER}-darwin-arm64/bin/node`, `node-${NODE_VER}-darwin-arm64/LICENSE`]);
  cpSync(join(CACHE, `node-${NODE_VER}-darwin-arm64/bin/node`), join(BIN, 'node'));
  cpSync(join(CACHE, `node-${NODE_VER}-darwin-arm64/LICENSE`), join(BIN, 'NODE-LICENSE.txt'));
}
await fetchNode();

// 3. stage (repo-shaped: main.js resolves ROOT = ../.. from packages/app)
rmSync(STAGE, { recursive: true, force: true });
const copy = (rel, filter) => cpSync(join(ROOT, rel), join(STAGE, rel), { recursive: true, filter });
const noTests = (src) => !/[\\/](test|node_modules)([\\/]|$)/.test(src.slice(ROOT.length));
copy('packages/app', (s) => noTests(s) && !s.endsWith('shot.js'));
copy('packages/solver/src'); copy('packages/solver/package.json');
copy('packages/cuetool/src'); copy('packages/cuetool/package.json');
copy('packages/analyzer/src'); copy('packages/analyzer/package.json');
// tfjs + tfjs-backend-wasm + essentia.js (runtime deps only). Drop symlinks (.bin: codesign rejects links
// pointing outside the bundle), source maps and type-only packages (~half the size).
copy('packages/analyzer/node_modules', (s) => !/[\\/](\.bin|@types|@webgpu)([\\/]|$)|\.map$|\.d\.ts$/.test(s));
copy('scripts/db-count.js');
copy('config');
copy('vendor/models');
cpSync(join(HERE, 'THIRD_PARTY_NOTICES.md'), join(STAGE, 'THIRD_PARTY_NOTICES.md'));
const appPkg = JSON.parse(readFileSync(join(ROOT, 'packages/app/package.json'), 'utf8'));
writeFileSync(join(STAGE, 'package.json'), JSON.stringify({
  name: 'dj-setlist', productName: 'DJ Setlist', version: appPkg.version,
  description: 'DJ setlist draft generator (offline)', author: 'alphablackoscar',
  main: 'packages/app/main.js', license: 'AGPL-3.0-only',
}, null, 2));
if (process.argv.includes('--stage-only')) { console.log('staged:', STAGE); process.exit(0); }

// 4. electron-builder
const electronVersion = JSON.parse(readFileSync(join(ROOT, 'packages/app/node_modules/electron/package.json'), 'utf8')).version;
sh(join(HERE, 'node_modules/.bin/electron-builder'), ['--mac', 'dmg', '--arm64', '--config', join(HERE, 'builder.json'),
  `-c.electronVersion=${electronVersion}`], { cwd: HERE });
