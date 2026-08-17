# Interpretation-of-External-Regulations-Agent

# 外规解读agent

外规解读agent 是一个证据优先、人工定稿的浏览器端监管文件分析工具。它支持监管文件与官方解读分源上传，本地解析 PDF、DOCX、TXT 和扫描 PDF，通过用户自带的 OpenAI 兼容模型接口生成结构化结论，并把每项结论反向绑定到原文证据。

本产品不替代法律或合规判断。监管原文完整性、效力状态、生效日期、重大禁止事项及机构影响必须由合规人员复核。

## 本地运行

需要 Node.js 24 和 pnpm 11.19.x。

```bash
PATH=/Users/yeahh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH
pnpm install --frozen-lockfile

# 推荐（稳定端口）
pnpm dev:local

# 如果 4173 被占用或有权限问题，改 4174
pnpm dev:alt

# 一键自动选端口启动（适配本地被占用场景）
pnpm dev:auto
```

> 如果你在本机直接运行 `pnpm dev:local` 提示端口/权限问题（如 `EPERM`），通常是环境绑定限制，不是应用本身问题。  
> 你可以先用 `pnpm dev:auto` 自动寻找可用端口，或切换到 `pnpm dev:alt`（4174）。

打开稳定链接为：  
- 本地开发：`http://127.0.0.1:4173/`
- 本地预览：`http://127.0.0.1:4173/`（或 `:4174`）
- 公开稳定链接：`https://yeahh12316-yeahh.github.io/Interpretation-of-External-Regulations-Agent/`

浏览器中填写的模型 API Key 只用于当前浏览器会话。仓库、构建过程和部署平台均不配置共享模型密钥。

## 发布前门禁

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm benchmark
pnpm build
pnpm scan:build
pnpm scan:secrets -- --root src --root scripts --root dist --root artifacts
```

`pnpm benchmark` 是绑定当前合成/脱敏语料的静态回归基准，不代表未知文件上的产品精度承诺。生产网址冒烟还需要由获授权人员显式提供 `PRODUCTION_BASE_URL`；本地构建成功不是部署成功证据。

## 部署与隐私

- [部署说明](docs/deployment.md)：推荐 Vercel 连接私有 GitHub 仓库，发布公开静态站点；GitHub Pages 通常公开，符合条件的 GitHub Enterprise Cloud 组织项目站点可配置私有可见性。
- [隐私说明](docs/privacy.md)：说明本地存储、用户自带模型接口和第三方数据流边界。

## 品牌授权

当前构建不包含 Deloitte 标识图片。只有在取得正式授权资产及明确的使用范围后，才能把相应标识加入产品；文字风格或颜色约定不构成商标授权。未经授权的标识不得进入 `src/`、`dist/` 或公开站点。

## 当前发布状态

仓库包含 CI、静态构建、敏感信息扫描和生产冒烟配置，但本任务尚未创建真实部署。只有公开 HTTPS 地址上的生产冒烟通过后，才能声明该网址已完成发布验收。
