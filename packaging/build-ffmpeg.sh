#!/bin/bash
# Build LGPL-only ffmpeg + ffprobe (arm64, static, no external deps except libmp3lame LGPL) for the .app.
# Why own build: ffmpeg-static (npm) = --enable-nonfree (NOT redistributable); ffprobe-static "arm64" = x86_64 binary.
# Scope = what the app needs (measured 2026-10-21):
#   analyzer: ffprobe duration; ffmpeg decode any lib format -> mono f32le @ rate (packages/analyzer/src/decode.ts)
#   preview : ffmpeg any -> mp3 192k stream (packages/app/main.js, aiff etc. Chromium cannot play)
# Output: packaging/bin/{ffmpeg,ffprobe}. Sources cached in packaging/.cache/. Re-run = no-op if bin exists (--force to rebuild).
set -euo pipefail
cd "$(dirname "$0")"
FF_VER=8.0
LAME_VER=3.100
CACHE=.cache; PREFIX="$PWD/$CACHE/prefix"; OUT=bin
[[ "${1:-}" != "--force" && -x $OUT/ffmpeg && -x $OUT/ffprobe ]] && { echo "bin/ffmpeg exists (use --force)"; exit 0; }
mkdir -p $CACHE $OUT "$PREFIX"

fetch() { [[ -f "$CACHE/$2" ]] || curl -fL --retry 3 -o "$CACHE/$2" "$1"; }
fetch "https://ffmpeg.org/releases/ffmpeg-$FF_VER.tar.xz" "ffmpeg-$FF_VER.tar.xz"
fetch "https://downloads.sourceforge.net/project/lame/lame/$LAME_VER/lame-$LAME_VER.tar.gz" "lame-$LAME_VER.tar.gz"
# Pinned on first download 2026-10-21 (Mac, trust-on-first-use). Mismatch = stop.
shasum -a 256 -c <<EOF
b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e  $CACHE/ffmpeg-$FF_VER.tar.xz
ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e  $CACHE/lame-$LAME_VER.tar.gz
EOF

NJ=$(sysctl -n hw.ncpu)
if [[ ! -f "$PREFIX/lib/libmp3lame.a" ]]; then
  rm -rf "$CACHE/lame-$LAME_VER"; tar -xzf "$CACHE/lame-$LAME_VER.tar.gz" -C $CACHE
  # lame 3.100 exports a symbol that no longer exists -> link error on macOS
  sed -i '' '/lame_init_old/d' "$CACHE/lame-$LAME_VER/include/libmp3lame.sym"
  (cd "$CACHE/lame-$LAME_VER" && ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-frontend --disable-dependency-tracking \
     CFLAGS="-O2 -arch arm64 -mmacosx-version-min=12.0" >/dev/null && make -j$NJ >/dev/null && make install >/dev/null)
fi

rm -rf "$CACHE/ffmpeg-$FF_VER"; tar -xJf "$CACHE/ffmpeg-$FF_VER.tar.xz" -C $CACHE
cd "$CACHE/ffmpeg-$FF_VER"
DEC=mp3,mp3float,mp2,mp2float,aac,aac_fixed,aac_latm,alac,flac,vorbis,opus,wavpack,ape
DEC=$DEC,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_s16be,pcm_s24be,pcm_s32be,pcm_f32be,pcm_f64be,pcm_u8,pcm_s8,pcm_alaw,pcm_mulaw
./configure --cc=clang --arch=arm64 --target-os=darwin \
  --extra-cflags="-I$PREFIX/include -mmacosx-version-min=12.0" --extra-ldflags="-L$PREFIX/lib -mmacosx-version-min=12.0" \
  --enable-static --disable-shared --disable-autodetect --disable-doc --disable-network --disable-debug \
  --disable-everything --disable-ffplay --enable-ffmpeg --enable-ffprobe \
  --enable-protocol=file,pipe \
  --enable-demuxer=mp3,mov,wav,aiff,flac,ogg,aac,w64,wv,ape \
  --enable-decoder=$DEC \
  --enable-parser=mpegaudio,aac,aac_latm,flac,vorbis,opus \
  --enable-libmp3lame --enable-encoder=libmp3lame,pcm_f32le \
  --enable-muxer=mp3,pcm_f32le \
  --enable-filter=abuffer,abuffersink,aresample,aformat,anull,atrim,asetnsamples \
  --enable-swresample >/dev/null
# Guard: license must be LGPL (no gpl / nonfree)
grep -q 'CONFIG_GPL 0' config.h && grep -q 'CONFIG_NONFREE 0' config.h || { echo "license guard failed"; exit 1; }
make -j$NJ >/dev/null
cd - >/dev/null
cp "$CACHE/ffmpeg-$FF_VER/ffmpeg" "$CACHE/ffmpeg-$FF_VER/ffprobe" $OUT/
cp "$CACHE/ffmpeg-$FF_VER/COPYING.LGPLv2.1" $OUT/FFMPEG-LICENSE-LGPL-2.1.txt
echo "built: $(./$OUT/ffmpeg -version | head -1)"
