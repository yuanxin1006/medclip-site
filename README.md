# 医剪 · 医学科普剪辑台（Netlify 静态部署包）

来源：`https://medclip-lab-7f3c2.zhouyuanxinchina.chatgpt.site/`

本目录保存了从公开部署地址下载的浏览器端代码，包括入口 HTML、CSS、Next.js/Turbopack JavaScript 包和 Web Worker 依赖。项目已经按 GitHub 仓库结构整理，可由 Netlify 直接发布，无需构建命令。

## 上传 GitHub

将本目录中的所有内容上传到仓库根目录，目录结构应为：

```text
medclip-site-code/
├─ .gitignore
├─ netlify.toml
├─ README.md
├─ serve.ps1
└─ public/
   ├─ index.html
   └─ _next/static/chunks/...
```

不要只上传 `public/index.html`；`public/_next/static/chunks/` 中的文件是页面运行所需依赖。

## 发布到 Netlify

1. 在 Netlify 选择 **Add new site → Import an existing project**。
2. 连接 GitHub 并选择该仓库。
3. 保持 **Base directory** 为空。
4. 保持 **Build command** 为空。
5. **Publish directory** 会由 `netlify.toml` 自动设置为 `public`。
6. 选择 **Deploy site**。

也可以把整个仓库文件夹拖到 Netlify Drop；拖拽部署时应直接拖入 `public` 文件夹，因为 Netlify Drop 不读取仓库根目录的 `netlify.toml`。

## 本地预览

需要安装 Python 3。在本目录打开 PowerShell，运行：

```powershell
python -m http.server 8000 --directory public
```

然后访问：`http://localhost:8000/`

也可以运行随附的 `serve.ps1`。

## 重要限制

- 这是部署后编译、压缩过的前端产物，不是原始 React/TypeScript 工程。
- 页面主要业务代码位于 `public/_next/static/chunks/1coi6js8t6416.js`。
- Next.js/React、浏览器端模型推理及 FFmpeg 相关依赖分布在其余 chunks 中。
- 服务端源码、平台配置、数据库、密钥及未公开接口无法从公开网页恢复，因此未包含。
- 页面运行时还会访问 jsDelivr、unpkg 和 Hugging Face 等外部资源；离线环境下部分转录或视频处理功能可能不可用。
- 语音转写首次运行需要下载 `Xenova/whisper-tiny` 或 `Xenova/whisper-base` 模型，耗时取决于访问 Hugging Face 的网络质量。
- 视频导出首次运行需要从 jsDelivr 或 unpkg 下载 FFmpeg Core 0.12.10；如果所在网络拦截这些 CDN，该功能会失败，但 Netlify 部署本身仍可正常完成。
- 请不要在 Netlify 中添加严格的 Content-Security-Policy，除非同时放行 `blob:`、Web Worker、Hugging Face、jsDelivr 和 unpkg，否则本地识别或视频导出会被浏览器拦截。

## 已完成的部署检查

- 首页和所有本地静态引用均已补齐。
- 17 个 Next.js/Turbopack 直接及二次引用资源均存在。
- 应用不依赖本站 `/api/` 接口，核心处理在浏览器中完成。
- Netlify 使用的发布目录和静态资源缓存规则已写入 `netlify.toml`。
- 原站点注入的 Cloudflare Challenge 脚本已删除，迁移到 Netlify 后不会再请求原来的 `/cdn-cgi/` 检测地址。

完整测试结果见 `DEPLOYMENT-CHECK.md`。
