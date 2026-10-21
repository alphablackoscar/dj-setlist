# packaging — macOS (Apple Silicon) .dmg

Owner = Mac (`.claude/CLAUDE.md` 役割分担). Plan = `docs/MAC_DIST_PLAN.md`.

## Build

```bash
cd packaging
npm install          # electron-builder only
npm run build        # -> dist/DJ Setlist-<ver>-arm64.dmg (~150MB), ~1 min (+1 min first ffmpeg build)
npm run stage        # stage/ only (inspect what goes in)
```

Needs: Xcode CLT (clang, make, codesign), network at build time only (Node / ffmpeg / lame / Electron downloads).
Not needed: Xcode, Apple Developer account (ad-hoc signed for now).

## What goes into the .app

| Path in .app | From | Why |
|---|---|---|
| Resources/app/ (= `stage/`, asar off) | packages/app, solver/src, cuetool/src, analyzer/src + node_modules, scripts/db-count.js, config, vendor/models | main.js spawns `node <file>` -> files must be real (no asar) |
| Resources/bin/node | official Node v24.10.0 darwin-arm64 (SHA256 vs nodejs.org) | Electron 33's Node 20 lacks node:sqlite + TS stripping |
| Resources/bin/ffmpeg, ffprobe | `build-ffmpeg.sh` (own LGPL build) | npm ffmpeg-static = --enable-nonfree (not redistributable); ffprobe-static "arm64" = x86_64 |

Runtime switch = `packages/app/paths.js` (only touch point in packages/app): when packaged, prepends Resources/bin to PATH
and points DJ_DB / DJ_XML / DJ_CONFIG / DJ_SETLISTS / DJ_OUT to `~/Library/Application Support/DJ Setlist/`.
config/ is re-copied each launch except `venues.json` (⚙ 設定 writes it).

## Verified (Mac 2026-10-21)
- codesign --verify --deep --strict OK (ad-hoc).
- Launch w/ `env -i PATH=/usr/bin:/bin` (no system node / ffmpeg): first run shows 「曲がありません。XML を読み込んでください」, creates Application Support dir + config.
- Same w/ DJ_DB / DJ_XML = repo data: 作る -> 3 candidates x 13 tracks in ~1s, output in Application Support/out.
- Bundled ffmpeg decodes mp3 / m4a (aac, alac) / aiff / wav / flac -> f32le; mp3 preview encode OK.
- Bundled analyzer loads all 3 models from inside the .app.

- 2026-10-21: 193 real tracks: XML import -> analysis (2.8 s/track) -> setlist inside the .app. Results ~identical to Windows (docs/DECISIONS.md 10-21).

## Not verified yet
- Gatekeeper on a friend's Mac (quarantined download, "Open Anyway"). Nested bin/node, bin/ffmpeg are ad-hoc signed too.
- rekordbox (Mac) import of the exported m3u8 / cue XML.

## Licenses
See `THIRD_PARTY_NOTICES.md` (shipped inside the .app). Models = CC BY-NC-SA 4.0 -> free distribution only.
