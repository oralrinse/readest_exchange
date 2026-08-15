# Readest VIP 移除项目 —— 完整交接上下文

> 生成日期：2026-08-09。这是给新对话 Claude 的完整上下文，务必先读这份文档再动手。

## 1. 项目目标与已确认决策

用户把开源阅读器 **Readest**（`apps/readest-app`，Next.js 16 + Tauri v2 monorepo）作为自己开发基座，要求**彻底去除付费/VIP/订阅系统**。已通过 AskUserQuestion 确认三项决策：

1. **彻底删除支付代码**（非只关付费墙）：payment library、支付 API routes、订阅/升级 UI、iap-reconcile worker、支付依赖、相关测试、Stripe env 变量；解锁所有付费功能。
2. **完全移除配额限制**：storage/translation quota limits、Quota 组件、UsageStats、quota UI 全部移除。
3. **保留登录**：Supabase auth、用户页面、云同步/书库/分享保持免费可用。

**全部任务已完成并验证通过。** 当前处于"可选后续项"阶段。

## 2. 仓库结构（重要！双目录 git worktree）

用 `git worktree` 做了隔离，**改动全部在独立 worktree 中**：

| 目录 | 分支 | 状态 |
|---|---|---|
| `H:/PersonalComputerSoftware/Code/repository/readest_without_vip` | `main` | **clean，0 改动**（用户 git 面板看到的是这个） |
| `H:/PersonalComputerSoftware/Code/repository/readest-remove-vip` | `remove-vip` | **145 处改动**（63 删除 + 82 修改） |

- **所有编辑只能在 `readest-remove-vip`（remove-vip 分支）进行**，绝不改主仓库。
- 用户 VSCode 打开的是主仓库，所以 git 面板看不到改动。要让用户看到改动：VSCode `File → Open Folder` 打开 worktree 目录，或在主仓库 `git merge remove-vip` 合并。
- 原始 plan 文件：`C:\Users\larva\.claude\plans\encapsulated-fluttering-simon.md`

## 3. 变更汇总（git status）

- **63 个文件删除**：9 条支付 API 路由（stripe/apple/google 各 3 条）、14 个 `src/libs/payment/` 文件（stripe/iap/iap.apple/iap.google）、8 个订阅 UI 组件（`src/app/user/components/` 下 PlanCard/PlansComparison/Checkout/PlanActionButton/PlanIndicators/PlanNavigation/PurchaseCallToActions/UsageStats）、`user/subscription/success/page.tsx`、`user/utils/plan.ts`、`hooks/useAvailablePlans.ts`、`hooks/useQuotaStats.ts`、`types/payment.ts`、`types/quota.ts`、`utils/iap.ts`、`utils/usage.ts`、6 个 `workers/iap-reconcile/` 文件、**18 个测试文件**。
- **82 个文件修改**：门控解锁、用户页重写、`utils/access.ts` 精简、`transferManager.ts` 去配额失败逻辑、`package.json` 删 6 依赖、`wrangler.toml` 删 AE binding、`tauri.conf.json` CSP 去 stripe、`.env`/`.env.local.example` 清理、34 个 `public/locales/*/translation.json` 重扫（删 3112 行孤儿支付键）。

## 4. 关键改动机制（用户最关心的部分）

### 官方门控机制
官方版：登录后 JWT `access_token` 内带 `plan` claim（'free'/'pro'/'lifetime'...）→ `getSubscriptionPlan(token)` 解析 → gate 函数（`isCloudSyncAllowed`/`getTranslationQuota`/`getDailyTranslationPlanData` 等）据此放行。**做法是删除整条 plan 判定链，让能力无条件可用**，但认证 `validateUserAndToken`（401）保留。

### 云同步
- `src/utils/access.ts`：**重写**，仅保留 `getAccessToken`/`getUserID`/`validateUserAndToken`，删除 Token 接口与全部 plan/quota 导出。
- `src/services/sync/cloudSyncProvider.ts`：删除 `cachedUserPlan`/`setCachedUserPlan`/`getCachedUserPlan`；`resolveCloudSyncGate` 的 `paused` **恒 false**（保留字段结构，下游零改动）；`getActiveFileSyncBackends` 直接返回 `backends`。
- `runLibrarySync.ts`/`ttsPackSync.ts`：去 plan 参数、删 `gate.paused` 判断。
- **官方后端 Readest Cloud 保留**：`isReadestCloudEnabled` 保留、`readest` provider 保留、R2/S3 官方对象存储 6 条路由（upload/download/delete/list/purge/stats）保留。

### 翻译
- `src/pages/api/deepl/translate.ts`：删 plan 分级选 key（free→api-free.deepl.com+DEEPL_FREE_API_KEYS，pro→api.deepl.com+DEEPL_PRO_API_KEYS），统一 `DEEPL_API`（默认 pro 端点）+ `DEEPL_API_KEYS`；删 `checkDailyUsage`/`updateDailyUsage`（UsageStatsManager）、429 分支；**保留 KV 翻译缓存**。
- `src/services/translators/providers/deepl.ts`：删 `getSubscriptionPlan`/`getTranslationQuota`/`saveDailyUsage`，`quotaExceeded` 字段保留但永不再置位。
- `src/utils/usage.ts`（UsageStatsManager）整个删除；`translators/utils.ts` 删 `DAILY_USAGE_KEY`/`saveDailyUsage`/`getDailyUsage`；`translators/types.ts` ErrorCodes 删 `DAILY_QUOTA_EXCEEDED`。

### 存储配额
- `src/pages/api/storage/upload.ts`：删 `getStoragePlanData` 的 `usage + fileSize > quota + STORAGE_QUOTA_GRACE_BYTES → 403 'Insufficient storage quota'` 检查，R2 上传逻辑（认证/签名 URL/files 表写入）原样保留。
- `src/services/constants.ts`：删 `DEFAULT_STORAGE_QUOTA`/`DEFAULT_DAILY_TRANSLATION_QUOTA`。
- `src/services/runtimeConfig.ts`：删 `storageFixedQuota`/`translationFixedQuota`。
- `src/services/transferManager.ts`：删 quota failure 分支（`QUOTA_TOAST_FLUSH_MS`/`quotaFailureCount`/`isQuotaError`/`recordQuotaFailure`/`flushQuotaToast`）。

### env 变更
- `DEEPL_PRO_API_KEYS`/`DEEPL_FREE_API_KEYS` → 合并为 `DEEPL_API_KEYS`（可选 `DEEPL_API` 指定端点）。
- `.env`：删 2 个 `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_*_BASE64` 行。
- `.env.local.example`：删 `NEXT_PUBLIC_STORAGE_FIXED_QUOTA`。
- `package.json`：删 6 依赖（`@googleapis/androidpublisher`、`@stripe/react-stripe-js`、`@stripe/stripe-js`、`app-store-server-api`、`google-auth-library`、`stripe`）。
- `wrangler.toml`：删 `IAP_WEBHOOK_AE` 的 `analytics_engine_datasets` binding。
- `tauri.conf.json`：CSP frame-src/script-src 删 `https://*.stripe.com`。

## 5. 已确认保留项（勿误删）

- **Supabase 登录**、`libs/user.ts`（deleteUser）、AuthContext、`workers/send-email/`。
- **OPDS/RSS "subscription"（订阅源）**、reedy "plan §M1"（文档）、IndexedDB "upgrade"、字体 "SF Pro" 等假阳性。
- **`QUOTA_EXCEEDED`**（`src/libs/errors.ts` + `src/libs/replicaSyncClient.ts`）：第三方存储（WebDAV/Drive 返回 402/507）的通用错误码，**不是 VIP 配额，必须保留**。
- **`ShareLanding.tsx` 的 "striped"**：CSS 条纹，非 Stripe。
- **R2/S3 官方对象存储**：全部保留，只是无配额。

## 6. 验证结果（全绿）

| 检查 | 命令 | 结果 |
|---|---|---|
| lint | `pnpm lint`（= `tsgo --noEmit && biome lint .`） | ✅ 0 错误，1931 文件 clean |
| 测试 | `pnpm test:pr:web:unit` | ✅ **8818/8828 通过**，691 文件，0 失败 |
| 构建 | `pnpm build`（dotenv -e .env.tauri -- next build） | ✅ exit 0，编译成功 + TS 0 错误，21/21 页面导出 |
| grep 断言 | VIP 关键词全仓搜索 | ✅ 0 命中 |

## 7. 环境要点（新对话务必知道）

- 项目约定：worktree 开发、测试优先、TS 严格模式、`@/*` → `src/*`。
- **测试必须加 env 前缀**，否则 supabase atob 崩溃：`dotenv -e .env -e .env.test.local -- vitest run ...`（`pnpm test:pr:web:unit` 已内置）。
- **git submodules 已初始化**（`git submodule update --init --recursive`）：js-mdict、simplecc-wasm、pdfjs-dist、tauri-plugin-turso（`src-tauri/plugins/tauri-plugin-turso/guest-js`）。缺子模块时 mdict 测试和 `tauri-plugin-turso` import 会报错。
- **vendor 文件已生成**（`pnpm setup-pdfjs` + `setup-simplecc` + `setup-jieba`）：`public/vendor/{pdfjs,simplecc,jieba}/`，对应 tsconfig aliases `@pdfjs/*`、`@simplecc/*`。simplecc 用的是 `packages/simplecc-wasm/dist/web` 预构建 wasm，**无需 wasm-bindgen**。
- 主要工作目录：`apps/readest-app`（pnpm 命令都在此运行）。
- `@simplecc/simplecc_wasm` → `./public/vendor/simplecc/simplecc_wasm`（dist/web 拷贝）；`tauri-plugin-turso` → tsconfig path 到 submodule guest-js。

## 8. 可选后续项（未做，用户尚未决定）

1. **原生层 IAP 清理**：`src-tauri` Rust `iap_*` 命令、`utils/bridge.ts` 的 `get_storefront_region_code`、`nativeAppService.ts` 的 `storefrontRegionCode`、`types/system.ts`、`appService.ts` 字段、测试 mock —— 均无生产消费方（死代码）。需动 src-tauri 并跑 Rust fmt/clippy/test。
2. **合并回主仓库**：用户确认后 `git merge remove-vip`。
3. **README donate 徽章** / `data/metainfo/appdata.xml` donate URL（低优先级）。

## 9. 用户最近关注点（可能继续追问）

1. **功能角度分析**：用户要过"功能层面有哪些变化"——移除付费体系、解锁付费功能（云同步/TTS 离线/发送到阅读器/翻译）、取消配额、保留登录。
2. **官方云端限制**：已如实告知三层——(a) 应用层配额已清零（跑这份代码的服务器无限制）；(b) 云平台硬限制保留（R2 免费 10GB/单文件 5GB、Supabase 免费 500MB、超出按量计费，删不掉）；(c) **连官方托管服务则无法保证**——官方私有服务器可能有独立配额校验，不在本仓库。
3. **git 面板无变化**：worktree 隔离所致，需打开 worktree 目录或合并分支。

## 10. 语言

与用户用**中文**交流。
