MedClip FFmpeg browser runtime notices

The locally hosted ESM JavaScript wrapper files at 0.12.15/ are copied unchanged from @ffmpeg/ffmpeg@0.12.15. The editor also uses @ffmpeg/util@0.12.2. These wrapper utilities are MIT licensed; see FFmpegWasm-MIT-LICENSE.txt. Upstream source: https://github.com/ffmpegwasm/ffmpeg.wasm

The actual FFmpeg Core remains @ffmpeg/core@0.12.10, loaded from the fixed jsDelivr URL with the existing unpkg fallback. Its package metadata is GPL-2.0-or-later. The Core files are not copied into this directory by this change. This wrapper notice does not replace the Core's own source and license obligations.

The Core is FFmpeg 5.1.4 built with GPL components including x264 and x265. See [GPL version 2](./FFmpeg-Core-GPL-2.0.txt), the [FFmpeg licensing notes](https://github.com/FFmpeg/FFmpeg/blob/n5.1.4/LICENSE.md), and the [ffmpeg.wasm release](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15) with its [build configuration](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v12.15/Dockerfile). The build configuration references the third-party libraries included in the Core. These upstream references do not constitute a verified complete corresponding source archive for the CDN binary.
