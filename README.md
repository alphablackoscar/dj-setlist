# DJ Setlist

Offline setlist draft generator for DJs who use rekordbox. macOS (Apple Silicon) desktop app.

- Reads your rekordbox collection XML, analyzes your tracks locally (BPM, key, energy, timbre), and proposes setlist drafts
  (13-track sets or 1-2 h long sets built from genre blocks). Export back to rekordbox as a playlist (.m3u8).
- **Fully offline.** No account, no network, no AI service. Your music never leaves your Mac.
- Drafts are a starting point: swap, insert, lock and re-pick tracks in the app.

## Install (friends' build)

1. Download `DJ Setlist-<version>-arm64.dmg` from **Releases**.
2. Open the .dmg and drag **DJ Setlist** to Applications.
3. First launch only: macOS blocks it (the app is not notarized by Apple).
   Open it once, then go to **System Settings > Privacy & Security** and click **Open Anyway**.

Requirements: Apple Silicon Mac (M1 or later), macOS 13.5 or later, rekordbox.

## Use

1. rekordbox: **File > Export Collection in xml format**.
2. DJ Setlist: **XML を読み込み** (load XML) and pick that file. First analysis takes ~3 s per track.
3. Choose time / venue / genres, press **作る** (build). Export the result and import the .m3u8 in rekordbox.

Data is stored in `~/Library/Application Support/DJ Setlist/`. Delete that folder to reset.

## Build from source

```bash
cd packages/app && npm install && cd ../analyzer && npm install
cd ../../packaging && npm install && npm run build      # -> packaging/dist/*.dmg
```

Needs Xcode Command Line Tools and network access at build time (downloads Node, FFmpeg, LAME, Electron sources/binaries).
Dev run: `cd packages/app && npx electron .` (needs Node 24 and ffmpeg on PATH).

## License

AGPL-3.0-only (see `LICENSE`). Bundled components and their licenses: `THIRD_PARTY_NOTICES.md`.
Pre-trained models are CC BY-NC-SA 4.0 (Music Technology Group, UPF): **non-commercial use only.**
