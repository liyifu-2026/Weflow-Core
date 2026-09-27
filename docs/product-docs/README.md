# Weflow 产品全景文档（Product Docs）

> **本文档族的目标**：一个此前从未接触过 Weflow 的人，只读这个文件夹，就能完整了解
> 这个产品的**前端、后端、数据、协议、通道、部署、运维、质量体系**的一切——
> 无需看代码运行效果。所有事实均来自仓库真实代码与文档，标注了出处路径；
> 内容基线为仓库 `main` 分支 **LLM_v1.2.0_D9.28**（2026-09-28）。

---

## 0. 产品一页纸

**Weflow** 是一个「**单进程部署、配置集中、可高效热更新的 AI 客服产品**」。
它把微信私聊/群聊消息接入、AI 自动接待（大模型决策 + 知识库检索 + 长期记忆）、
人工接管协作（Handoff）、素材与媒体处理、手机端推送，组织成一个**可审计、可热更新、
不停机**的系统。

| 维度 | 结论 |
|------|------|
| 产品形态 | 微信客户侧 + 三端工作人员入口（网页端 / 桌面端 / 手机端） |
| 仓库 | 唯一仓库 `weflow`（引擎层 + 业务子树同仓），remote `github.com/liyifu-2026/Weflow-Core` |
| 后端 | Node.js 24 + Fastify 5 + PostgreSQL 16（唯一事实源）+ Redis 7（BullMQ 队列/事件扇出），三进程：core-api(3100) / agent-worker(3101) / ingestion-worker(3102) |
| 网页端 | Vue 3 + Vite + Tailwind v4 单页应用 `support-web`（browser history 真实路径），由 core-api 静态托管 |
| 桌面端 | Tauri 2 + WebView2 壳（`Weflow_2.0.0_x64-setup.exe`），加载同一套 support-web/dist，支持远程接入 |
| 手机端 | Expo SDK 57 / React Native 0.86.3（`@weflow/mobile` 0.9.0），FCM 推送 + EAS OTA 热更新 |
| 微信通道 | Python 进程 `channel-host-wechat`（43123，本机回环），直读微信 DB + UIA 自动化发送 |
| AI 决策 | DeepSeek `deepseek-v4-flash`（OpenAI 兼容），思维链保留，JSON 决策协议 + 原生 FC 探针通过 |
| 知识库 | WeKnora（外部 Provider，X-Api-Key 检索），设置中心热配置 |
| 部署 | Windows 服务器（生产机 ThinkPad X230，`192.168.0.108`），NSSM 服务化 + 计划任务 + frpc 公网隧道（`*.leaif.com`） |
| 热更新 | 前端整包替换秒级生效；worker 滚动重启 api 零中断；模型/知识/行为设置全部界面热生效 |

---

## 1. 文档目录

| 文件 | 内容 | 适合谁读 |
|------|------|----------|
| [01-产品概述.md](01-产品概述.md) | 产品定义、用户角色、功能地图、版本与沿革 | 所有人，从这里开始 |
| [02-系统架构与数据流.md](02-系统架构与数据流.md) | 进程拓扑、端口、消息主链路、事件流、部署形态 | 后端 / 运维 / 架构 |
| [03-Core引擎后端.md](03-Core引擎后端.md) | 17 个模块逐一详解、分层规则、进程入口、队列、ADR 决策 | 后端开发 |
| [04-数据模型与数据库.md](04-数据模型与数据库.md) | 全部 PG schema / 表 / 关键字段 / 迁移体系（77 个迁移，0000–0080） | 后端 / DBA |
| [05-API接口全集.md](05-API接口全集.md) | 全部 REST 端点（鉴权/路径/用途/幂等语义）+ SSE + 静态托管 | 前端 / 集成 |
| [06-Agent编排与模型协议.md](06-Agent编排与模型协议.md) | 回合状态机、决策协议（9 动作）、工具、记忆、群聊/私聊机制、模型协议实测数据 | 算法 / 后端 |
| [07-通道层-channel-host.md](07-通道层-channel-host.md) | 微信通道适配器：协议 v6、入站捕获、出站发送、媒体、UIA 自动化 | 通道 / Python |
| [08-业务子树-solutions.md](08-业务子树-solutions.md) | 业务 BFF、客服策略插件（提示词体系）、weknora-connector、插件加载机制 | 业务开发 |
| [09-网页端-support-web.md](09-网页端-support-web.md) | 路由全表、工作台/设置中心/管理页逐页详解、组件与状态管理、实时机制 | 前端 |
| [10-手机端-mobile.md](10-手机端-mobile.md) | 屏幕清单、API、推送、附件口径、构建/OTA 发布、已知坑 | 移动端 |
| [11-桌面端与Console.md](11-桌面端与Console.md) | Tauri 壳架构（连接页/地址解析/远程接入）、Console 退役白名单 | 桌面端 |
| [12-配置与环境变量.md](12-配置与环境变量.md) | 全部环境变量（含默认值/必填性）、设置中心配置面、密钥卫生 | 运维 / 全栈 |
| [13-部署与运维.md](13-部署与运维.md) | 从零部署、Windows 服务化、热更新规程、X230 生产机、frpc 隧道、排障 | 运维 |
| [14-安全与合规.md](14-安全与合规.md) | 认证/会话/限流、密钥管理、隐私口径（媒体不落盘/通知脱敏）、边界红线 | 安全 |
| [15-测试与质量体系.md](15-测试与质量体系.md) | 126 个 core 测试文件（+setup）、集成测试、e2e gate、platform:verify、CI、lint 门禁 | 质量 / CI |
| [16-术语表与历史沿革.md](16-术语表与历史沿革.md) | 领域词汇表、新旧术语对照、15 条 ADR 摘要、错误日志（错题本） | 所有人 |

---

## 2. 三分钟速览：一条客户消息的一生

```
客户在微信里发来一张破损产品的照片 + 一句语音"你看看这东西怎么办"
   │
   ▼ ① 通道捕获
channel-host-wechat（Python，与微信桌面版同机）
   直读微信加密本地库（SQLCipher）取到文字消息；图片/语音经媒体提取
   （图片 AES 密钥解密 / 语音 SILK 格式识别），写入 SQLite 事件库，
   每会话维护 source checkpoint 水位
   │
   ▼ ② 入站事件（HTTP 轮询，127.0.0.1:43123 → 3100）
core-api 的 event poller 以 500ms 间隔拉 /api/v1/channel/events（Bearer token）
   ingest 幂等入库（conversations / messages），语音/图片建 media_assets 行
   │
   ▼ ③ 合并窗口（Turn Admission）
消息不立即建轮：先进 turn_admission_states 合并窗（普通 12s，半句启发式延长 30s），
客户连发只建一个 Turn，省模型调用
   │
   ▼ ④ Agent Turn（BullMQ 队列 agent-turns → agent-worker）
Triage 小模型先分流（人工/自动、简单/标准）→ 装配上下文：
   【会话事实卡】+ 长期记忆 12 条 + 轮窗摘要 + 最近 20 条原文 + 客户档案
   │
   ▼ ⑤ 系统喂 + 模型要 + 模型做
图片描述（vision）、语音转写（ASR）由 ingestion-worker 并行完成并回填；
模型可调 retrieve_knowledge（WeKnora 检索）→ 工具检查点 → 证据回喂 → 续步
   │
   ▼ ⑥ 决策（14 字段 JSON，思维链保留）
模型输出 reply_segments（≤8 段）→ 策略闸门（高危/高风险强制转人工）
→ 重复回复指纹拦截 → 发送期插话闸门
   │
   ▼ ⑦ 出站
send operation（operationId 幂等）→ channel-host /api/v1/channel/send
→ UIA 自动化在微信窗口逐段发送（打字节拍）→ 5 态回执对账（unknown 必查证）
   │
   ▼ ⑧ 三端可见
conversation-events 事件总线（Redis pub/sub）→ SSE 推网页端/手机端
→ 会话列表、决策轨迹、AI 思考胶囊实时更新；90s 安静窗口后提取长期记忆
```

若模型判断「该转人工」：Handoff 状态机启动 → 网页端/手机端推送 →
客服认领 → 归属锁保证人与 AI 不双发 → 解决归档 → AI 继续待命。

---

## 3. 仓库与文档地图

```
weflow/                          # 唯一仓库（本文件夹也在仓内 docs/product-docs/）
├── core/                        # 引擎后端（17 模块，见 03/04/05 章）
├── apps/console/                # 退役中平台壳（冻结，见 11 章）
├── apps/desktop/                # Tauri 桌面壳（见 11 章）
├── packages/                    # contracts / plugin-sdk / ui（见 08 章 §契约包）
├── runtimes/channel-host-wechat # 微信通道（Python，见 07 章）
├── tooling/weflowctl/           # 运维 CLI（见 13 章）
├── solutions/customer-support/  # 业务子树：support-web + mobile + plugins + backend
│                                #   （WeKnora 对接已内化 core/infrastructure/knowledge/*，
│                                #    旧 weknora-connector 插件包目录已不存在）
└── docs/product-docs/           # ← 本文档族
```

配套的一手文档（本文档族是它们的「全景整合版」，细节争议以一手文档与代码为准）：

| 一手文档 | 内容 |
|----------|------|
| 根 `AGENTS.md` / `CONTEXT.md`（仓外工作区） | 工作区宪法、全局架构与词汇表 |
| `weflow/AGENTS.md`、`core/AGENTS.md`、`solutions/AGENTS.md` | 分层执行守则 |
| `core/CONTEXT.md`、`solutions/CONTEXT.md` | 引擎/业务领域词汇表 |
| `core/docs/adr/0001–0015` | 引擎层架构决策记录 |
| `docs/deployment-guide.md`（仓内） | 部署与热更新规程 |
| `docs/technical-documentation.md`（仓内） | Console 帮助页内容源（v2.1） |
| `docs/ops.md`（工作区） | 本机/X230/隧道/桌面/手机端运维速查 |
| `docs/plans/THINKING-PIPELINE-PLAN.md`（工作区） | 模型协议实测记录（已完结） |
| `solutions/customer-support/apps/mobile/docs/dev-debug.md` | 手机端调试速查 |

---

## 4. 阅读姿势建议

- **只想知道"这是什么产品"**：读 §0 一页纸 + 01 章，10 分钟。
- **要接手后端开发**：01 → 02 → 03 → 04 → 06，再对照 `core/AGENTS.md`。
- **要接手前端**：01 → 09 → 05（API 契约），再读 10/11 了解另外两端。
- **要部署/接管运维**：01 → 02 → 13 → 12，X230 相关细节在 13 章 §X230。
- **要审计安全**：14 章 + 04 章 identity 部分 + 12 章密钥卫生。
