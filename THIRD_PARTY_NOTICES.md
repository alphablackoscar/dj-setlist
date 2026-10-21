# Third-party components bundled in DJ Setlist (.app)

App itself: AGPL-3.0-only (required by essentia.js below). Source: https://github.com/alphablackoscar/dj-setlist

| Component | Version | License | Where in .app | Notes |
|---|---|---|---|---|
| Electron | 33.x | MIT | Contents/Frameworks | includes Chromium (BSD-3-Clause and others; see Electron's LICENSES.chromium.html) |
| Node.js | v24.10.0 | MIT (+ bundled deps, see NODE-LICENSE.txt) | Resources/bin/node | official darwin-arm64 build, SHA256 checked at build |
| FFmpeg (ffmpeg, ffprobe) | 8.0 | LGPL-2.1-or-later | Resources/bin | own build, `packaging/build-ffmpeg.sh`: no --enable-gpl / --enable-nonfree; source = ffmpeg.org/releases/ffmpeg-8.0.tar.xz |
| LAME (libmp3lame, static in ffmpeg) | 3.100 | LGPL-2.0-or-later | inside Resources/bin/ffmpeg | source = sourceforge lame 3.100 |
| essentia.js | 0.1.3 | AGPL-3.0 | Resources/app/packages/analyzer/node_modules/essentia.js | Music Technology Group, Universitat Pompeu Fabra |
| TensorFlow.js (tfjs, tfjs-backend-wasm) | 4.22 | Apache-2.0 | Resources/app/packages/analyzer/node_modules/@tensorflow | |
| Pre-trained models msd-musicnn-1, danceability-msd-musicnn-1, emomusic-msd-musicnn-1 | - | CC BY-NC-SA 4.0 | Resources/app/vendor/models | (c) Music Technology Group, UPF. "All the models created by the MTG are licensed under CC BY-NC-SA 4.0" (essentia.upf.edu/models.html, checked 2026-10-21). Unmodified. **Non-commercial use only.** |

LGPL relinking: ffmpeg is a separate executable invoked as a process (not linked into the app); its exact source and build script are provided above, so users can rebuild and replace Resources/bin/ffmpeg.
