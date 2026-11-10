MedClip FFmpeg browser runtime notices

The locally hosted ESM JavaScript wrapper files at 0.12.15/ are copied unchanged from @ffmpeg/ffmpeg@0.12.15. The editor also uses @ffmpeg/util@0.12.2. These wrapper utilities are MIT licensed; see FFmpegWasm-MIT-LICENSE.txt. Upstream source: https://github.com/ffmpegwasm/ffmpeg.wasm

The actual FFmpeg Core remains @ffmpeg/core@0.12.10, loaded from the fixed jsDelivr URL with the existing unpkg fallback. Its package metadata is GPL-2.0-or-later. The Core files are not copied into this directory by this change. This wrapper notice does not replace the Core's own source and license obligations.
