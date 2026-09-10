# dsh-nexus

[English](./README.en.md) | 中文

DeepSeek Harness（`dsh`）的观测插件（`@dsh-external/dsh-nexus`）：为 Obsidian vault 与 AI 会话提供**双面板量化观测**——vault 侧元数据快照与编辑统计，会话侧逐轮遥测与形态分析。对 vault 只读，观测数据全部私有化存储（`~/.dsh/nexus/`），重启/重载不丢不重。

## ① Vault 观测

- **全量扫描**：启动 + 周期校准（默认 6h）——路径/修改时间/大小/字数（去空白字符，排除 frontmatter）；
- **编辑监听**：`fs.watch`（recursive）实时感知 vault 变更（Obsidian 关闭时同样可采），500ms 去抖合并，`created`/`modified`/`deleted` 幂等记账；
- **观测面板**：文件总数/总字数、今日与本周编辑统计、活跃文件 Top 5、最近编辑流；
- **指向确认**：观测只取自指向的 vault，历史数据按 root 隔离、可回切；排除规则可配。

## ② 会话读数（L 场读数）

把「一段对话对知识库走了多远」变成数字——**会话级 LLM 观测 + 量化自评 + 曲线形态分析**：

- **指标口径**：token（输入/输出/缓存命中）、缓存命中率与未命中率（未命中率 = A 投影）、TPS 与解码耗时、每轮主观清晰度自评（0–1）——**主客观双指标交叉验证，互相限制偏差**（客观曲线有缓存预热与新话题混杂，主观自评有报告偏差）；
- **官方事件直采**：订阅宿主 `session/event`（**零宿主源码修改、无第三方插件依赖**），数据私有目录隔离（`~/.dsh/nexus/`，SQLite，重启/重载不丢不重）；
- **双 tab 看板**：SVG 曲线支持**放大、筛选（时间窗/会话）、问答回看**（逐轮完整问答原文）；
- **可重复分析管线**：形态分类（S 形/上升/下降/反转 S）· 特征时间 τ_e 检出 · 分桶对照——首轮实证：**vault 会话未命中率 13.7% vs 非指向工作区 5.6%**，与知识型会话探索密度更高一致；
- **自评覆盖**：逐会话覆盖徽标（已评/总轮次 + 缺口轮号），低于 80% 预警；
- **预言检验表**：P1–P9 假设逐条标注（待验证/进行中/已检验），分析结论回写。

> 「L 场」是作者私人研究框架（L-theory）的用语；对外部使用者，把这块读作**会话级 LLM 观测看板**即可——指标本身（token/缓存/TPS/自评）都是标准的可观测性量。

## 指向与视图

- 插件有两个**独立指向**：**vault 指向**（观测对象）与 **L 场指向**（会话归属的 vault 根），均可在面板内确认/切换（二次确认，历史不删）；
- 会话归属规则：**发起时所在工作区**——在指向 vault 的工作区内发起的会话归入 vault 视图，其余只在全局视图出现；历史会话按同一规则回溯归类；
- 看板两视图：**全局**（全部工作区会话）/ **〈vault 短名〉**（在指向工作区发起的会话），对照分析即视图切换。

## 安装

```sh
dsh plugin --profile <name> add github:chemmy-11/dsh-nexus
```

git 形式安装会在本机构建（`prepare` 脚本需要 dsh 源码 checkout：自动探测 `$DSH_CHECKOUT` 或 `~/dsh-harness`）；pnpm ≥10 首次安装需在 profile 的 `pnpm-workspace.yaml` 按提示放行 `allowBuilds`。

配置示例（profile 的 `cordis.patch.yml`；`vaultRoot` 可省——面板内指向确认即可，config 仅作初始种子）：

```yaml
- id: nexus
  config:
    vaultRoot: 'C:/path/to/your/obsidian/vault'
    exclude: [dsh-docs]
    watchEnabled: true
    pollIntervalMs: 21600000
    debounceMs: 500
```

## API（同源访问）

| 端点 | 说明 |
|---|---|
| `GET /api/nexus/state` | vault 总量 / 今日 / 本周 / 最近编辑流 |
| `GET/POST /api/nexus/vault` | vault 指向状态 / 切换 |
| `GET /api/nexus/m2/state` | 会话读数（latest / totals / curve / selfcheck 覆盖；`?root=all` 切全局视图） |
| `GET/POST /api/nexus/m2/annotations` | 预言标注读写 |
| `GET /api/nexus/m2/turn-text` | 某轮完整问答原文 |
| `GET /api/nexus/m2/analysis` | 白盒分析（S 形 / 爆发段 / τ_e） |
| `GET/POST /api/nexus/lfield` | L 场指向状态 / 切换 |

## 构建

```sh
DSH_CHECKOUT=<dsh-checkout> bash scripts/build.sh   # = node scripts/prepare.mjs（host tsc + client esbuild）
```

构建链为纯 Node 实现（`scripts/prepare.mjs` + `scripts/build-client.mjs`），不依赖 bash 环境差异。

**两种构建模式**（`scripts/prepare.mjs` 自动选择）：
- **checkout 模式**（本地开发）：探测到 `$DSH_CHECKOUT` / `~/dsh-harness` → 从 checkout junction 链接 `cordis`/`schemastery`/`dsh-host-webserver` 并复用其 tsc/esbuild；
- **npm-devDeps 模式**（CI / 无 checkout）：`npm install` 装好 devDependencies 后直接用本地依赖构建，无需 dsh 源码。

## CI

`.github/workflows/ci.yml` 在每次 push/PR 上跑 `typecheck` + `build`（npm-devDeps 模式）+ 测试 + 元数据校验（bundle patch / client 双半 / files 清单）；`.github/workflows/release.yml` 在 `v*` tag 上自动构建 tgz 并创建 GitHub Release。

## 设计原则

- **独立可装**：仅依赖官方 `cordis`/`schemastery`/`dsh-host-webserver`，不与任何其它插件耦合；
- **观测即留痕**：编辑与会话读数从部署起前向积累（SQLite 持久化，重启/重载不丢不重）；
- **边界意识**：只读 vault、数据私有化（不进 vault、不混入其它数据源）；
- **归属不混数**：会话按发起工作区归属，vault 会话与其它工作区会话分开分析（同一分类规则，不做时间分代）。

## 安全说明

安装插件等于在机器上运行第三方代码，权限与运行者相同。安装前请先阅读源码；本插件对目标 vault 只读，不执行写入。
