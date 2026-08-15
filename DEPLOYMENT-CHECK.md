# Netlify 部署检查记录

检查日期：2026-08-15

## 结果

- `netlify.toml`：语法解析通过，发布目录为 `public`。
- 静态依赖：17 个直接及二次引用的 Next.js/Turbopack 文件全部存在，无缺失资源。
- 桌面浏览器：HTTP 200，React 页面完成加载，无控制台错误、无失败请求。
- 手机视口（390 × 844）：HTTP 200，无横向溢出、无控制台错误、无失败请求。
- 交互冒烟测试：点击“载入演示”后素材数量由 0 更新为 4，说明客户端交互与状态更新正常。
- 安全检查：未发现常见 API Key、GitHub Token、AWS Key 或私钥格式。
- 迁移清理：已移除原托管平台注入的 Cloudflare Challenge 脚本，Netlify 不再请求 `/cdn-cgi/challenge-platform/`。
- 文件大小：单文件均远低于 GitHub 的 100 MB 限制。

## 外部运行依赖

部署本身不需要后端接口。以下功能会在访客浏览器中访问第三方服务：

- Hugging Face：下载 Whisper 模型，用于本地字幕识别。
- jsDelivr / unpkg：下载 FFmpeg Core，用于本地视频合成。

这些第三方服务的网络可用性不由 GitHub 或 Netlify 保证；若所在网络无法访问它们，网站页面仍可打开，但对应的识别或导出功能可能失败。
