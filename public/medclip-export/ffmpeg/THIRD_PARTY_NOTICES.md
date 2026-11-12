MedClip FFmpeg browser runtime notices

The locally hosted ESM JavaScript wrapper files at 0.12.15/ are copied unchanged from @ffmpeg/ffmpeg@0.12.15. The editor also uses @ffmpeg/util@0.12.2. These wrapper utilities are MIT licensed; see FFmpegWasm-MIT-LICENSE.txt. Upstream source: https://github.com/ffmpegwasm/ffmpeg.wasm

The actual FFmpeg Core remains @ffmpeg/core@0.12.10, loaded from the fixed jsDelivr URL with the existing unpkg fallback. Its package metadata is GPL-2.0-or-later. The Core files are not copied into this directory by this change. This wrapper notice does not replace the Core's own source and license obligations.

The Core is FFmpeg 5.1.4 built by the ffmpeg.wasm project with Emscripten 3.1.40 and GPL components including x264 and x265. The ESM JavaScript and WASM served by both jsDelivr and unpkg match the official `@ffmpeg/core@0.12.10` npm package byte for byte.

| ESM file | Bytes | SHA-256 |
| --- | ---: | --- |
| `ffmpeg-core.js` | 111,804 | `67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3` |
| `ffmpeg-core.wasm` | 32,232,419 | `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7` |

- [GPL version 2](./FFmpeg-Core-GPL-2.0.txt), [FFmpeg licensing notes](https://github.com/FFmpeg/FFmpeg/blob/n5.1.4/LICENSE.md), and [FFmpeg 5.1.4 source](https://ffmpeg.org/releases/ffmpeg-5.1.4.tar.xz).
- [ffmpeg.wasm release for Core 0.12.10](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15), [source and build scripts at the release commit](https://github.com/ffmpegwasm/ffmpeg.wasm/archive/71aa99d37c02a7b4c435275ca9ef50e612f6efa1.tar.gz), and [Dockerfile with linked libraries and build inputs](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/71aa99d37c02a7b4c435275ca9ef50e612f6efa1/Dockerfile).

The exact x264 `4-cores` and LAME `master` revisions used by the published build remain unverified. Complete corresponding source for the CDN binary is pending.
