# MedClip Beta 发布准备检查

日期：2026-11-10

## 当前范围

目标是建立独立 GitHub 发布分支。没有创建 PR、没有合并 main、没有触发 Netlify 部署。正式网站保持旧版本。

## 已有构建和测试证据

复用隔离发布准备目录中 2026-11-10 的证据：

- pnpm exec next build --webpack：静态构建通过；out 约 6.85 MB、118 个文件。
- TypeScript 检查通过。
- 定点测试 11/11 通过。
- 完整 pnpm test 为 1322/1323；唯一失败是缺少 Playwright chromium_headless_shell 执行文件，属于测试环境问题。
- Edge 普通编辑器使用视频原声，FFmpeg 抽音并加载 Base 资源完成真实 Whisper 推理和字幕生成。该隔离测试使用英语合成语音并固定中文识别参数，不能作为中文字幕准确率验收。
- 26 个 ASR 资源的 SHA-256/字节数全部通过。Tiny 尚未完成真实推理。
- 构建产物未包含模型权重或 21.6 MB ONNX WASM；ASR runtime 通过固定外部资源路径按需加载。

完整记录：D:/Codex/workspace/medclip-release-prep-20261109/ASSET_LOADING_VALIDATION_20261110.md 和 ASR_REAL_BROWSER_EVIDENCE_20261110.json。

## 尚未满足的线上条件

- 没有已批准的公网 HTTPS ASR 资源端点；Production/Deploy Preview 的 NEXT_PUBLIC_MEDCLIP_ASSET_BASE_URL 尚不能设定。
- 真实 COS 或 Netlify Blobs 上的完整资源下载、无 VPN 中国大陆可达性、中文讲话准确率、Tiny 推理和 SRT 磁盘落盘尚未全部验证。
- FFmpeg Core 仍通过 jsDelivr/unpkg 外部 CDN；GPL-2.0-or-later 自托管方案未完成合规审核。
- Netlify 生产环境变量和 Supabase Auth 回调设置未通过控制台复核。
- 该提交不应合并 main，也不应部署正式站点。

## Netlify 配置

- Build command: pnpm exec next build --webpack
- Publish directory: out
- Node: 24
- 正式分支: main

## 注意

本检查文件描述已取得的隔离证据和剩余阻断，不构成生产验收或部署批准。

