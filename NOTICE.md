# Third-party software

This player bundles or loads the following. Keep these notices (and the linked source offers) when you distribute it.

| Component | Used for | Licence |
|---|---|---|
| FFmpeg 9.0 (compiled to WebAssembly, custom `lite` build) | opens AVI, WMV, FLV, MPEG, TS, MKV … and decodes older codecs (MPEG-1/2/4, WMV, AC-3, DTS …) | LGPL-2.1-or-later. Source: https://ffmpeg.org/releases/ . The decoder is a separate `.wasm` file (`public/vendor/libav/`) so it can be replaced with your own build; build notes in `scripts/libav-README.md`. |
| libav.js 6.10.9 | JavaScript wrapper for FFmpeg | ISC / 0BSD. https://github.com/Yahweasel/libav.js |
| libavjs-webcodecs-bridge 0.3 | turns demuxed stream data into WebCodecs configuration | ISC |
| hls.js 1.7 | HLS streams | Apache-2.0 |
| dash.js 5.2 | DASH streams | BSD-3-Clause |

Development tools (Vite, Vitest, TypeScript) are not part of the shipped app.

## Patents

**H.264, HEVC and AAC (and VP8/VP9, AV1, Opus, Vorbis) are not decoded by this app.** The visitor's browser decodes them through WebCodecs, and
browser vendors carry the licences for that. The WebAssembly build (`public/vendor/libav/`, variant `lite`) contains no decoder for them: it only
demuxes (opens the container).

The build does still contain decoders for older codecs: MPEG-1/2/4 (DivX/Xvid), VC-1, Windows Media Video/Audio, Sorenson (FLV), AC-3, E-AC-3,
DTS and MP1/2/3. Most of these are old, but patent status differs by country and codec (Windows Media, DTS and E-AC-3 are the likeliest to still
matter). Check the position for your use before a commercial release. To be more conservative, delete `decoder-wmv1/2/3`, `decoder-vc1`,
`decoder-wmav1/2`, `decoder-dca` and `decoder-eac3` from `scripts/config.json` and rebuild (`scripts/libav-README.md`); those files then show a
"can't play" message.

## Name

"Web Player" is a placeholder. Do not use "VLC" or "VideoLAN" in the product name, logo or domain: they are VideoLAN trademarks. This project does
not contain VLC source code.
