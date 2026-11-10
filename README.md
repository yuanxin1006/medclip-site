# MedClip Beta 发布准备源码

这是 MedClip TypeScript/Next.js 项目树，替代仓库此前保存的旧版预编译静态页面。正式 Netlify 站点仍绑定 main；此发布分支仅用于审阅，不代表已部署。

## 构建与本地运行

要求 Node.js 24 和 pnpm。干净构建步骤：

1. pnpm install --frozen-lockfile
2. pnpm exec next build --webpack
3. Next.js 静态导出写入 out/；Netlify 配置发布 out/

Netlify 构建配置位于 netlify.toml。运行本地静态预览前先完成构建，再运行 PowerShell 脚本 serve.ps1，默认地址为 http://localhost:8000/。

## 已纳入的产品能力

本代码树包含 MedClip 首页、登录、音乐作品、AI 歌曲生成与 Provider 配置、视频剪辑、四种音频模式、Whisper 字幕、字幕编辑、精确导出、速度控制、画面比例、Human Review、保护约束及 Undo/Redo 等产品代码。实际验收范围与限制见 DEPLOYMENT-CHECK.md 和隔离发布准备目录的测试证据。

## 模型及运行时资源

模型权重没有提交 Git。Whisper Base/Tiny、ONNX Runtime WASM 和 tokenizer/config 由外部版本固定的 ASR 资源根目录提供。上线识别前，必须为 Netlify Production 和 Deploy Preview 配置 NEXT_PUBLIC_MEDCLIP_ASSET_BASE_URL，并验证资源文件哈希、MIME、HTTPS 与 CORS。缺少生产资源地址时，识别流程会明确报错，不会改用浮动的公共模型 CDN。

本轮未启用 CLIP 公共资源托管。现有视觉代码保留在源码树中；不得将此分支描述为 CLIP 在线推理已完成。

## 安全

- 不提交 .env.local、服务端密钥、用户资料、视频或字幕文件。
- NEXT_PUBLIC_* 值会进入浏览器；只能包含公开客户端配置。
- Whisper 和 CLIP 大文件由独立资源流程管理，不放入 Git。
- 不要把本分支合并 main 或部署到正式站点，除非另行完成用户验收和明确授权。

