# 部署说明

## 推荐方案：Vercel 连接私有 GitHub 仓库

Vercel 是本项目的优先托管方案：获授权的仓库管理员在 Vercel 控制台导入私有 GitHub 仓库，由 Vercel 按 `vercel.json` 执行冻结依赖安装和 Vite 构建，并把 `dist/` 作为公开静态站点发布。

`vercel.json` 使用官方 SPA rewrite，把非静态资源路由回退到 `/index.html`；Vercel 实际 build command 同时执行 `pnpm build && pnpm scan:build`，因此敏感信息扫描失败时托管构建本身失败，而不只是等待外部 CI。配置依据为 [Vercel Project Configuration](https://vercel.com/docs/project-configuration/vercel-json)。发布项目应设置为公开访问；私有源代码仓库并不等于私有网站。

Vercel preview 可以先构建，但 production promotion 必须绑定到通过全部 GitHub required checks 的精确 commit SHA。管理员应启用 branch protection/required status checks，并在 Vercel 中使用 deployment checks 或人工 promotion：核对候选部署的 `VERCEL_GIT_COMMIT_SHA` 与已通过 CI 的 GitHub SHA 完全一致后，才允许把 production alias 指向该部署。不能因同分支已有旧绿灯而 promotion 新 SHA，也不能用 preview 成功替代 GitHub 全门禁。

这是部署目标上的外部必做项，当前仓库配置无法替管理员开启。未配置 required Deployment Checks/人工 promotion 约束，或无法提供 SHA 对账证据时，发布不得验收。代码内 `build && scan:build` 只闭合候选构建产物与扫描之间的差异，不能替代 production promotion gate。

部署平台不得配置共享的模型 Base URL、模型名或 API Key。模型设置由每个用户在运行时界面填写，浏览器直接向用户选择的 HTTPS 模型服务商发送请求。`.env.example` 只有说明，不提供任何构建值。

发布前必须满足：

1. GitHub `CI` 和 `Build secret scan` 工作流成功；
2. 冻结安装、类型检查、Vitest、Playwright、基准门禁和生产构建全部通过；
3. `node scripts/scan-build-secrets.mjs dist` 对缺失目录或任何发现 fail-closed；
4. `dist/` 不含 API Key、上传样本、测试响应、真实项目数据或未经授权的品牌资产；
5. 获授权人员核对 Vercel 的公开访问与 SPA deep-link 行为。

## GitHub Pages 备选边界

GitHub Pages 是否能从私有仓库发布取决于账户与组织套餐。Pages 站点通常公开；例外是符合条件的 GitHub Enterprise Cloud 组织：从该组织拥有的 private/internal repository 发布的 project site 可以启用访问控制并配置为私有，Enterprise Managed Users 还有更严格限制。采用前必须由仓库管理员核对当前套餐、站点类型、组织政策和实际 visibility，不能仅凭仓库是 private 推断站点私有。官方依据见 [Configuring a publishing source for your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) 和 [Changing the visibility of your GitHub Pages site](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site)。

当前仓库没有 Pages 发布 workflow，也没有为子路径调整 Vite base path，因此不能把 Vercel 配置原样视为 Pages 发布配置。若获授权改用 Pages，应单独评审 base path、公开性和最小权限，不能绕过现有 CI 与敏感信息扫描。

## 经授权后的生产冒烟

先确认公开站点已发布，然后由获授权人员在本地 shell 临时注入地址：

```bash
read -r PRODUCTION_BASE_URL
test -n "$PRODUCTION_BASE_URL"
export PRODUCTION_BASE_URL
pnpm test:production
```

`playwright.production.config.ts` 要求显式公网 HTTPS 地址，拒绝 URL credentials、query/fragment、localhost 后缀、loopback、RFC1918、link-local、ULA 等非公网地址；它没有本地 fallback，并保留获授权的显式子路径。测试先打开该子路径下的 deep link 验证 SPA fallback，再在生产 App 中解析真实文字层 PDF 与运行时生成的合成扫描 PDF，验证 OCR worker/core/language assets 全部同源，随后完成分析、证据切换、人工修订与四份报告下载。模型请求只在浏览器网络层拦截合成 `.invalid` 域名，使用合成会话值，不需要也不得使用真实 API Key。

测试通过后还应人工确认站点 URL、部署版本 SHA、Vercel 访问设置和无关键控制台错误。不要把本地 `pnpm build` 或预览服务器当作线上验收。

## 授权与回滚

本任务不创建 remote、不 push、不调用部署 API。连接仓库、发布公开 URL 和回滚均属于外部状态变更，只能由拥有相应权限且明确获授权的人员执行。回滚到已验证构建后，应重新运行生产冒烟并记录部署 SHA。
