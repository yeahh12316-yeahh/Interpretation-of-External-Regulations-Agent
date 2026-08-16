# 部署说明

## 推荐方案：Vercel 连接私有 GitHub 仓库

Vercel 是本项目的优先托管方案：获授权的仓库管理员在 Vercel 控制台导入私有 GitHub 仓库，由 Vercel 按 `vercel.json` 执行冻结依赖安装和 Vite 构建，并把 `dist/` 作为公开静态站点发布。

`vercel.json` 使用官方 SPA rewrite，把非静态资源路由回退到 `/index.html`。配置依据为 [Vercel Project Configuration](https://vercel.com/docs/project-configuration/vercel-json)。发布项目应设置为公开访问；私有源代码仓库并不等于私有网站。

部署平台不得配置共享的模型 Base URL、模型名或 API Key。模型设置由每个用户在运行时界面填写，浏览器直接向用户选择的 HTTPS 模型服务商发送请求。`.env.example` 只有说明，不提供任何构建值。

发布前必须满足：

1. GitHub `CI` 和 `Build secret scan` 工作流成功；
2. 冻结安装、类型检查、Vitest、Playwright、基准门禁和生产构建全部通过；
3. `node scripts/scan-build-secrets.mjs dist` 对缺失目录或任何发现 fail-closed；
4. `dist/` 不含 API Key、上传样本、测试响应、真实项目数据或未经授权的品牌资产；
5. 获授权人员核对 Vercel 的公开访问与 SPA deep-link 行为。

## GitHub Pages 备选边界

GitHub Pages 是否能从私有仓库发布取决于账户与组织套餐；而 Pages 站点本身面向互联网公开。采用前必须由仓库管理员核对当前套餐、组织政策和公开访问风险。官方依据见 [Configuring a publishing source for your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

当前仓库没有 Pages 发布 workflow，也没有为子路径调整 Vite base path，因此不能把 Vercel 配置原样视为 Pages 发布配置。若获授权改用 Pages，应单独评审 base path、公开性和最小权限，不能绕过现有 CI 与敏感信息扫描。

## 经授权后的生产冒烟

先确认公开站点已发布，然后由获授权人员在本地 shell 临时注入地址：

```bash
PRODUCTION_BASE_URL="https://approved-public-host.example" pnpm test:production
```

`playwright.production.config.ts` 要求显式 HTTPS 地址，并拒绝 localhost、回环地址和缺失变量；它没有本地 fallback。测试在浏览器网络层拦截合成模型域名的 OpenAI 兼容请求，使用合成会话凭证，不需要也不得使用真实 API Key。它仍通过生产 App 完成双来源上传、真实本地解析、分析、证据切换、人工修订与四份报告下载。

测试通过后还应人工确认站点 URL、部署版本 SHA、Vercel 访问设置和无关键控制台错误。不要把本地 `pnpm build` 或预览服务器当作线上验收。

## 授权与回滚

本任务不创建 remote、不 push、不调用部署 API。连接仓库、发布公开 URL 和回滚均属于外部状态变更，只能由拥有相应权限且明确获授权的人员执行。回滚到已验证构建后，应重新运行生产冒烟并记录部署 SHA。
