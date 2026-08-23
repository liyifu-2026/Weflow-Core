# 工作树提交拆分方案（草稿）

日期：2026-08-23
状态：待评审（需 owner 拍板开放问题后再执行）
前提：**先冻结所有并行会话**（本方案编写期间仍有会话在实时改文件）。

---

## 0. 现状盘点（git status 全量归类）

### 任务/工作流归属
| 代号 | 内容 | 主要证据 |
|---|---|---|
| **E 语音双路径** | 微信语音 transcript 直通 + SILK→MP3→ASR 备选 | 本会话；spec 无（任务书即 spec） |
| **C 文件消息归一化** | kind=file 事件、mediaRef、fileName/mimeType | `docs/superpowers/specs/2026-08-23-wechat-file-media-normalization-design.md` |
| **D 图片缩略图回退** | X-Media-Variant、sourceVariant 列、原图升级 | `docs/superpowers/{specs,plans}/2026-08-23-wechat-image-thumbnail-fallback*` |
| **A Console 平台壳**（归属待确认） | console 组件重构、knowledge 视图删除、packages/ui、design-system 文档、start-dev.ps1 | 无 spec；约 60 个文件 |
| **B Memory/Solution 域**（归属待确认） | memory importance（0054 迁移）、memory-maintenance、solution-health-service、agent 工具链改动 | 无 spec；约 12 个文件 |

### 共享文件（跨任务交织，无法按文件粒度拆）
| 文件 | 交织任务 |
|---|---|
| `runtimes/.../host.py`、`media.py`、`event_store.py`、`http_host.py` | C+D+E（且整个 `runtimes/` 目录从未入库） |
| `core/modules/media/application/sync-channel-media.ts`（改名自 sync-channel-images） | C 改名+kinds、D variant 落库、E voice kinds |
| `core/infrastructure/channel/http-channel-provider.ts` 及两个 contract | C resolveFile/schema、D variant、E resolveAudio |
| `core/modules/conversations/application/ingest-channel-events.ts` | C file、E voice |
| `core/apps/api/main.ts` | C syncChannelMedia 改名、E asrConfigured 接线 |
| `core/migrations/meta/_journal.json` | D 0055 与 B 0054 各一行 |

### 秘密与垃圾排查
- `runtimes/.gitignore` 已覆盖 `.data/`、`.venv/`、`image_keys.json`、`*.log` ✓（`git add runtures/channel-host-wechat` 会自动排除）
- `core/.env` 未出现在 status ✓
- 待确认勿入库：`weflow-solutions/screenshots_take.py`（临时脚本？）、`weflow-solutions/AGENTS.md`（??，来源待 owner 确认）、`support-web/dist/`（构建产物策略见 Q3）

---

## 方案一（推荐）：按"域/层"分提交，消息中注明涵盖的任务

> 原则：**每个提交必须能独立通过 typecheck + 相关测试**。由于共享文件的
> 存在，C/D/E 在 Core 侧按依赖顺序合为三个连续提交；Host 侧因目录无基线
> 且同文件交织，整体作为一个初始导入提交。

### weflow 仓库（7 个提交，顺序执行）

| # | 提交消息（conventional，subject 英文，正文中文注明任务） | 文件范围 |
|---|---|---|
| 1 | `feat(channel-host): WeChat adapter with text/image/file/voice capture and SILK media`<br>正文：包含 C 文件事件、D 缩略图回退（key_service/X-Media-Variant）、E voice 事件与 audio/x-silk 端点；对应 specs 见 docs/superpowers | `runtimes/channel-host-wechat/` 整目录（.gitignore 自动排除运行数据） |
| 2 | `feat(core-media): provider-neutral media seam (resolveFile/resolveAudio/thumbnail variant)`<br>C+D+E 底座；含 `tests/http-channel-provider.test.ts` | `modules/channel/contracts/*` ×2、`infrastructure/channel/http-channel-provider.ts`、`channel-media-poller.ts`、`infrastructure/postgres/schema.ts`、`migrations/0055_*`、`migrations/meta/_journal.json`（仅 0055 行——若 journal 含 B 的 0054 行，则本提交只 stage 该行，0054 文件留给 #6）、`tests/http-channel-provider.test.ts` |
| 3 | `feat(core-media): unified inbound media sync (file ready-fast, voice→ASR queue) + original upgrade`<br>C 摄取/同步 + D 升级 + E 摄取部分 | `modules/conversations/application/ingest-channel-events.ts`、`modules/media/application/sync-channel-media.ts`（含删除 `sync-channel-images.ts`）、`modules/media/application/upgrade-channel-image-originals.ts`、`apps/api/main.ts`、`tests/channel-file-media.integration.test.ts`、`tests/channel-image-upgrade.integration.test.ts`、`tests/channel-media-processing.integration.test.ts` |
| 4 | `feat(core-media): SILK→MP3 transcoding + MiMo ASR voice pipeline with honest degradation`<br>纯 E，无共享文件 | `modules/media/application/process-voice-transcription.ts`、`infrastructure/media/audio-transcoder.ts`、`infrastructure/model_runtime/mimo-audio-client.ts`、`infrastructure/redis/media-processing-dispatcher.ts`、`apps/ingestion-worker/main.ts`、`modules/agent/application/agent-context.ts`、`tests/audio-transcoder.test.ts`、`tests/channel-voice-media.integration.test.ts`、`tests/voice-transcription.integration.test.ts` |
| 5 | B 域提交（**由其作者提供消息与确认**）：`0054_memory_importance.sql` + journal 行 + `modules/memory/**` + `memory-extraction.test.ts` + `solution-*` 2 文件 + `modules/agent/application/{execute-tool-plan,process-agent-turn,process-planned-tool-turn,tool-catalog}.ts` |
| 6 | `feat(console): platform shell refresh + solution-sdk/ui updates`（A 域，由其作者确认拆分粒度）：`apps/console/**`（M+D+??）、`packages/**`、`contracts/channel/README.md`、`deploy/README.md`、`docs/solution-install.md`、`docs/console-design-system.md`、`scripts/start-dev.ps1`、根 `AGENTS.md`、`README.md` |
| 7 | `docs(superpowers): file-media normalization & thumbnail fallback designs` | `docs/superpowers/` |

> 注意 #2 的 journal 行拆分：`git add -p core/migrations/meta/_journal.json`
> 只选 0055 条目；若嫌手术繁琐，可将 0054+journal 整体并入 #5 且把 #2 排在
> #5 之后（调整顺序为 …#5(B)→#2→#3→#4…，E/C/D 不受影响，因为它们不依赖 0054）。

### weflow-solutions 仓库（2~3 个提交）

| # | 提交消息 | 文件范围 | 归属 |
|---|---|---|---|
| S1 | `feat(support-web): show voice transcript text with honest placeholder` | `solutions/customer-support/apps/`（整体 untracked→首次入库；dist 策略见 Q3） | E |
| S2 | 由并行作者确认：`package.json`、`plugins/customer-support-strategy/*`（src/prompt/package/prompts.json）、`backend/*/index.js`、`solution.manifest.json`、`solution.lock.json`、`signature.json`、`artifacts/support-web.tgz` | A/B 作者 |
| S3 | 杂项确认后处理：`AGENTS.md`（根，Q4）、`screenshots_take.py`（建议不入库或移 scripts/） |

---

## 方案二（备选）：严格按任务三段拆分

对 6 个共享 Core 文件 + 4 个 Host 共享文件做 hunk 级手术：
1. 冻结并行会话 → `git stash push --include-untracked` 全量快照留底；
2. 以 HEAD 为基线，按 C→D→E 顺序逐任务重放文件内容（每轮从 stash 中
   恢复对应 hunks），每轮跑该任务测试（host unittest / core 定向 vitest）；
3. 三个任务各成一提交，Host 侧仍受"目录无基线"限制只能按文件分组
   （event_store/http_host→C，key_service/variant 相关→D，voice 相关→E，
   media.py/host.py 需 add -p）。

**代价与风险**：约 10 文件 × 3 轮手工冲突解决；期间任何并行写入都会作废
重来；收益仅是历史美观。除非有审计/回滚强需求，不建议。

---

## 每提交后的验证门禁（两方案通用）

```powershell
# weflow/core
pnpm typecheck
pnpm vitest run tests/<该提交相关测试>
# 最终一次性：
$env:TEST_DATABASE_URL="<weflow_test>"; pnpm test   # 当前已知遗留：A/B 域 3 文件 lint 错误（非本三任务）

# weflow/runtimes/channel-host-wechat
python -m unittest discover channel_host/tests

# weflow-solutions
solutions/customer-support/apps/support-web: pnpm build
```

---

## 开放问题（需拍板后才执行）

1. **Q1 执行窗口**：谁能冻结并行会话？我可在冻结后代为执行方案一并逐提交跑门禁。
2. **Q2 Host 三合一**：`runtimes/` 初始导入将 C/D/E 的 Host 侧合为一个提交（理由见上），是否接受？
3. **Q3 构建产物策略**：`support-web/dist/` 是否随源码入库？（manifest entry 指向 `/plugins/customer-support/apps/support-web/dist/support-console.js`，若运行时直接读 dist 则需入库；否则建议 ignore + 发布走 artifacts tgz）
4. **Q4 两份根 AGENTS.md**：weflow 根（M）与 weflow-solutions 根（??）分别是谁写的？随 A 域提交还是单独 docs 提交？
5. **Q5 A/B 域提交人**：Console 壳与 memory/solution 域由原会话作者自行提交，还是本方案代为打包（消息我来拟）？
6. **Q6 lint 遗留**：`execute-tool-plan.ts`、`memory-maintenance.ts`、`solution-health-service.ts` 的 lint 错误需在 #5 前由其作者修复，否则最终 `pnpm check` 无法全绿。
