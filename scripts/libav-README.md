# libav.js build for the built-in video player

`public/vendor/libav/` holds a custom build of [libav.js](https://github.com/Yahweasel/libav.js)
(FFmpeg 9.0 compiled to WebAssembly, libav.js 6.10.9.0). The player loads it only when a file
needs it (AVI, WMV/ASF, FLV, MPEG, TS, WMA, and MKV/MP4 with AC-3/DTS/WMA sound). It is a
single-threaded build, because GitHub Pages cannot send the headers WebAssembly threads need.

Files: `libav-lite.mjs` (loader), `libav-6.10.9.0-lite.wasm.mjs` (glue), `libav-6.10.9.0-lite.wasm.wasm` (3.4 MB).
The variant is called `lite` because it has **no H.264 or AAC decoder**: those (and HEVC, VP8/9, AV1, Opus, Vorbis) are decoded by the
browser through WebCodecs, so the app ships no decoder for the most heavily patented codecs. libav.js only demuxes them.

## What is inside

`config.json` lists the libav.js configuration fragments. In short:

- Demuxers: MP4/MOV, Matroska/WebM, AVI, FLV, MPEG-TS, MPEG-PS, ASF, RealMedia, MP3, Ogg, WAV, FLAC
- Video decoders: MPEG-1/2/4, MS-MPEG4 v1–v3, FLV (Sorenson), WMV1/2/3, VC-1
- Audio decoders: AC-3, E-AC-3, DTS, MP1/2/3, WMA v1/v2, FLAC, PCM
- Parsers and bitstream filters for H.264, HEVC and AAC (needed to split transport streams for the browser's decoders)
- No HEVC, VP8/VP9, AV1, Opus, Vorbis or encoders: browsers decode those natively.

## Rebuild

Needs Emscripten 6.0.5 (emsdk), `make`, `m4`, `curl` and Node. On macOS the FFmpeg configure step
needs `--ar=emar --nm=emnm` (the system `ar` writes empty archives and the link then fails).

```sh
git clone --depth 1 --branch v6.10.9.0 https://github.com/Yahweasel/libav.js.git
cd libav.js/configs
node mkconfig.js lite "$(cat ../../scripts/libav/config.json)"
printf -- '--ar=emar --nm=emnm\n' >> configs/lite/ffmpeg-config.txt   # macOS only
cd .. && source /path/to/emsdk/emsdk_env.sh
make dist/libav-6.10.9.0-lite.wasm.mjs dist/libav-6.10.9.0-lite.mjs dist/libav-lite.mjs
cp dist/libav-lite.mjs dist/libav-6.10.9.0-lite.* ../../public/vendor/libav/
```

`build.sh` is the script used during the spike (paths assume the spike's folder layout).

## Licence and patents

FFmpeg is LGPL-2.1+; libav.js's own code is ISC/0BSD. The build contains no GPL components. Source for
FFmpeg 9.0 and libav.js is available from their projects, and the exact configuration is in `config.json`.
H.264, HEVC and AAC are not decoded by this build. The remaining decoders (MPEG-1/2/4, VC-1, WMV/WMA, Sorenson, AC-3, E-AC-3, DTS) are
older, but some are still patent-encumbered in some jurisdictions (Windows Media, DTS and E-AC-3 are the likeliest). To be even more
conservative, delete `decoder-wmv1/2/3`, `decoder-vc1`, `decoder-wmav1/2`, `decoder-dca` and `decoder-eac3` from `config.json` and rebuild.
See "Legal information to confirm" in the main README before a commercial launch.
