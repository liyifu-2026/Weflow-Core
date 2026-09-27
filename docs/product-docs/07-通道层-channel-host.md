# 07 · 通道层 Channel Host（微信适配器）

> 出处：`runtimes/channel-host-wechat/`（`channel_host/` + `wechatauto/`）、
> `packages/contracts/src/channel.ts`（协议权威）、`contracts/channel/README.md`、
> `core/infrastructure/channel/http-channel-provider.ts`。

## 1. 定位与进程模型

Channel Host 是**平台级通道入口适配层**：连接外部入口（微信）、可靠事件存储、发送操作、
媒体引用解析。Core 只通过协议 v6 的四个正式能力与其通信（events / send / media / contacts），
**不读通道私有 DB、不理解 `local_id`**。

- 组成：`channel_host/`（Weflow Channel Host，`__version__ 0.1.0`）+ `wechatauto/`
  （微信 4.x Windows 客户端自动化库，wxauto 复刻版 `wechatauto-replica` 1.2.2.2，
  同步上游 + Weflow 加固补丁；X230 现部署团队库 **V1.3.0 / vendored wechatauto 1.2.4.1**）。
- Python ≥3.9（3.12 验证），uv 管理；依赖 uiautomation / pywin32 / Pillow / psutil /
  cryptography / zstandard / winsdk / silk-python / imageio-ffmpeg / pyautogui / opencv-python。
- **进程模型**（`channel_host/main.py`）：单进程——1 条主轮询线程（`poll_once()` + 出站处理）
  + 1 个 HTTP 服务线程（ThreadingHTTPServer，daemon）+ 图片密钥后台线程 + **发送单线程执行器**
  （GUI 自动化不可并发）+（可选）UI 原图下载后台线程 + Backfill 后台线程。
- 启动顺序：读 `CHANNEL_HOST_TOKEN` → 开 `WeChatDB` → 建 SQLite EventStore → 媒体下载器 →
  ImageKeyService → `recover_send_operation_leases()`（清上个进程遗留租约）→
  HTTP 线程 → 空库则自动回溯 → `bootstrap()` 占坑各会话水位 → 主循环。
- **为什么不可服务化**：UIA 自动化依赖已登录微信桌面窗口，必须运行在**登录用户的桌面会话**
  （锁屏时发送不可用）——生产用计划任务 `Weflow ChannelHost`（登录时 `run.ps1 -Detached`）。

## 2. 通道协议 v6（`CHANNEL_PROTOCOL`，唯一权威 `packages/contracts/src/channel.ts`）

- 版本沿革：v2 加 historical 标记；v3 移除出站 voice；v4 出站加 recall + 入站加 video；
  v5 移除出站受限 voice（PC 微信无语音条转发入口，.silk 以文件发送无法播放）；
  **v6**：errorCodes 补全全集 + eventKinds 权威化 + `conversationKind` 上报 +
  `inFlightSendOperationStates`。
- `sendOperationStates`: `pending | executing | confirmed | unknown | failed`
  （`executing` 是 Host 中间态，Core 语义等价在途；Core 必须能解析否则 outbound cycle 中断）。
- `inFlightSendOperationStates`: `pending | executing`。
- `sendKinds`: `text | file | image | reply | mention | poke | recall`。
- `eventKinds`（入站）: `text | image | file | voice | emotion | pat | video`。
- `conversationKinds`: `private | group`；`mediaStates`: `ready | pending | not_found | failed`。
- `errorCodes` **38 个**（HTTP 层 15 + 发送/对账层 23），全集：
  <br>（注：`channel.ts` 头注中「HTTP 层 8 码」是陈旧注释，实际数组为 15 码——以本清单为准。）
  <br>**HTTP 层（15）**：`send_operation_identity_conflict`、`media_pending`、`media_not_found`、
  `not_found`、`channel_contacts_unavailable`、`invalid_request`、`channel_host_error`、
  `account_mismatch`、`unauthorized`、`media_too_large`、`media_unreadable`、
  `media_key_refresh_unavailable`、`backfill_unavailable`、`backfill_already_running`、
  `store_not_empty`。
  <br>**发送层 / 对账（23）**：`wechat_send_not_confirmed`、`at_requires_at_least_one_member`、
  `recall_window_expired`、`recall_not_found`、`recall_unsupported`、`video_not_found`、
  `reply_target_not_latest`、`mention_member_not_found`、`text_payload_empty`、
  `image_path_required`、`file_path_required`、`reply_text_required`、`mention_text_required`、
  `mention_members_required`、`invalid_sender_result`、`malformed_send_operation`、
  `malformed_text_payload_for_reconciliation`、`missing_payload`、
  `missing_send_baseline_for_reconciliation`、`non_text_send_not_reconcilable`、
  `send_not_confirmed_after_crash`、`tickle_not_confirmed`、`uia_driver_unavailable_for_tickle`。
  <br>（另有一组 **Host 内部发送原因码**，不出现在协议快照中：`send_execution_timeout` /
  `send_execution_in_progress` 等，见 §5。）
- **跨语言传导**：`weflow/scripts/sync-channel-protocol.ts` 从 TS 常量生成 Host 侧
  `channel_protocol.py`（头部 DO NOT EDIT）；CI `--check` 强制一致；**禁止 Python 侧手抄字面量**。
- `ChannelEvent` 字段：eventId、cursor、conversationRef、`account?`（ADR-0005）、
  `conversationKind?`（ADR-0010）、channelMessageId?、senderRef?、kind、content、mediaRef?、
  fileName?/mimeType?（file 由 Host 提供）、occurredAt?、observedAt、isSelf、`mentioned?`、
  `replyToChannelMessageId?`、`historical?`（回溯合成事件**零副作用**：不建 Turn/记忆/通知/转写）。
- `ChannelSendPayload` 7 型：text / file{path,fileName?} / image{path} / reply{text,replyToChannelMessageId} /
  mention{text,mentionContactRefs} / poke / recall（撤回最后一条己方消息，2 分钟窗口微信判定）。
- `ChannelSendRejectedError`：HTTP 4xx 明确拒收 → Core 标 failed 继续；传输类故障仍中断整轮
  （防队头堵塞冻结）。

## 3. HTTP API（默认 `http://127.0.0.1:43123`，全部 Bearer `CHANNEL_HOST_TOKEN`）

| 方法 路径 | 用途 |
|-----------|------|
| GET `/api/v1/channel/capabilities` | 协议能力快照（weflowctl doctor 用它做协议对齐检查） |
| GET `/api/v1/channel/events?afterCursor=&limit=` | 拉事件页 `{events, nextCursor, hasMore, maxCursor?, epoch?}`（epoch=store 代次，检测事件库被整体换新） |
| GET `/api/v1/status` | 健康检查：`host_alive` / `wechat_process_alive` / `db_readable` |
| GET `/api/v1/channel/accounts` | 本机微信账号列表（不含密钥）+ activeAccount |
| GET `/api/v1/channel/contacts?afterCursor=&limit=` | 联系人分页同步 |
| GET `/api/v1/channel/media/<mediaRef>` | 媒体流：pending→202；not_found→404；>25MB→413；ready→200 流 + `X-Media-Variant: original\|thumbnail`（缩略图回退标记，Core 据此排队原图升级） |
| GET `/api/v1/channel/send-operations/<operationId>` | 单条发送操作查询（对账） |
| POST `/api/v1/channel/send` | 创建发送操作：重复 operationId 不同 payload→409 `send_operation_identity_conflict`；账号不匹配→409 `account_mismatch`；kind 越界→400 |
| POST `/api/v1/channel/media-key/refresh` | 运维：显式刷新图片 AES 密钥（响应只含 `{available}`，绝不回显密钥） |
| POST `/api/v1/channel/sync` | 运维：重扫微信历史（historical 通道，幂等零 AI 副作用）；进行中→409 |
| POST `/api/v1/channel/backfill` | 空库历史回溯；非空库需 `{"force":true}`（409 `store_not_empty`） |
| GET `/healthz` | 健康探针（无 token 401 = 正常） |

Core 侧消费：`http-channel-provider.ts`（zod strict schema 全部从协议常量派生）+
四个轮询器（event / contact / media / outbound，api 进程，500ms 间隔）。

## 4. 入站捕获

- **SQLCipher 解密直读微信 DB**：`wechatauto/db.py`（3122 行）在 Weixin.exe 进程内存只读扫描
  提取每库 32 字节密钥（`com.Tencent.WCDB.Config.Cipher` 字符串→配置对象回溯→异或掩码→
  SQLCipher 4 HMAC 校验），缓存 `%TEMP%\wechatauto_db\<账号>\keys.json`；解密按页落临时目录，
  按源 mtime/size 复用；WAL 合并只合并帧 salt 一致的帧；`quick_check` 校验 + 坏缓存自动重建。
  **权限要求**：脚本提权级别须与微信一致（微信管理员运行时脚本也须管理员——即「UAC 提权」的
  实际含义；`weflowctl dev up` 对 channel-host 标记 elevated=true 自动 UAC）。
- **水位**：`source_checkpoints(conversation_ref PK, sort_seq)`；capture 在同一
  `BEGIN IMMEDIATE` 事务里 INSERT OR IGNORE 事件 + 水位只进不退；bootstrap 把各会话水位占坑到
  当前最大 sort_seq；运行期新发现会话以**进程启动时刻为基线**（界线前历史不导入——修复
  「新客户首条消息被吞」）；cursor 单调自增（迁移修复清表后回卷导致 Core 摄取停摆）。
- **消息种类**（local_type 判定）：text(1)、image(3)、voice(34)、file(49 且 appmsg type=6——
  链接卡片/合并转发/小程序**不**伪造文件事件)、emotion(47)、video(43)、pat（type 10000 系统
  「拍了拍」或 appmsg title 含拍一拍，**优先于 file 分支**）、quoted reply（appmsg type=57 抽
  refermsg 文本 + reply_to_channel_message_id）。
- **语音**：微信「语音自动转文字」开启时 content 直接是转写文本；未开启时 content 空 + mime
  `audio/x-silk`，media 端点返回 **SILK 原始字节**，SILK→PCM→MP3→ASR 在 Core ingestion 侧完成
  （诚实降级：转码不可用 → `transcode_unavailable` turn，不静默）。
- **表情包文本化**（0077）：从 XML `<emoji>` 节点提取 name/title/description，命中内置映射表
  （九分类 + 微信内置小黄脸 60+ 词条）→ `[表情包]<含义>`，兜底 `[表情包]表情`；
  **不携带 mediaRef**（截图链路已下线，历史 mediaRef 一律 failed `emoji_capture_unavailable`）。
- **mediaRef**：`wechat-media:v1:sha256(event_id)`（重启稳定）。
- **@提及检测**（fail-open 三层）：`@昵称` 精确 → `@wxid` → 群聊兜底「含任意 @ 即 true」
  （假阳性只多一次模型调用，假阴性丢请求；私聊不用兜底）。
- **isSelf 判定**：单一事实源 `WeChatDB.is_self_sender`（自适应各版本 real_sender_id 语义——
  两台实机语义相反：开发机自己=2、X230 自己=1）；群消息剥离 `wxid_|gh_|数字:` 前缀。
- **conversationKind**：`@chatroom` 后缀 → group 否则 private（v6 上报，Core 落 `chat_type`）。

## 5. 出站发送

- **5 态机**：pending →（`claim_send_operation` 原子认领：state=pending 且租约空闲 → executing +
  baseline_sort_seq + attempts+1 + lease 60s）→ confirmed / unknown / failed（finish 只接受终态，
  清租约）；启动时 `recover_send_operation_leases()` 释放遗留。
- **对账优先**：每轮先取 reconciliation 队列（executing 遗留）——无 baseline→
  `unknown(missing_send_baseline_for_reconciliation)`；**非 text 一律 unknown
  （non_text_send_not_reconcilable）**（GUI verify 依赖当次会话）；text 在 baseline 后找同文本
  自消息行（`find_self_text_after`）→ confirmed(channel_message_id) 或
  `unknown(send_not_confirmed_after_crash)`。
- **执行**：text 先 pre-send 对账（库里已有同文本 → 直接 confirmed 不重发）；然后单线程执行器
  `_dispatch_send_bounded`。
- **发送执行墙钟超时**（v1.2.0 新增）：常量 `SEND_EXECUTION_TIMEOUT_SECONDS` 默认 180，
  经 env **`CHANNEL_HOST_SEND_TIMEOUT_SECONDS`** 调整（见 §7 环境变量表）。
  上一次发送仍挂着 → 立即 `unknown(send_execution_in_progress)` 不进 UI；超时 →
  `unknown(send_execution_timeout)`——**超时≠失败，交给歧义对账（有库证据→confirmed，
  无证据→unknown），绝不重发**。（背景：2026-09-20 X230 卡在 OCR 38 分钟，整个宿主静止。
  注意这两个原因码是 **Host 内部 `SendAttempt` 原因码**，不在协议 `errorCodes` 快照内。）
- **歧义对账窗口**：30s、每 1s 轮询（原 8s 必然超时——实测微信写库 +7s、解密缓存 +17.7s 才可见）；
  「已操作发送/未确认/verification_timeout」等歧义标记归 unknown 而非 failed。
- **各 kind 实现**（`WeChatChannelSender`）：
  - text：conversation_ref 是 opaque wxid，**绝不打进微信搜索框**——用 db 解析成昵称/备注，
    解析失败即取消（`ContactResolutionError`）；UIA 优先、OCR 兜底。
  - image / file：CF_HDROP 剪贴板粘贴路线。
  - reply：仅能回复最新可见消息（非最新 → failed `reply_target_not_latest`）。
  - mention：成员逐个弹层 OCR 选人；成员资格预检（不在群里直接 failed
    `mention_member_not_found`，省掉注定失败的 UI）；空 members → failed。
  - poke（拍一拍）：UIA 像素重心选头像右键 + OCR 定位「拍一拍」；UIA 不可用 → failed。
  - recall：UIA `recall_last_message`，失败映射 `recall_window_expired`。
  - GUI 异常 → `_fail_with_gui_reset`（丢弃缓存 GUI 会话自愈，返回 unknown）。

## 6. GUI 自动化（`wechatauto/guia.py`，坐标 + OCR 路线）

微信 4.1.12+ 聊天区域自绘渲染不暴露无障碍节点，此模块提供兜底路线：
Win32 多特征定位主窗口（类名 `Qt51514QWindowIcon` 只是软条件，联合标题/进程/可见/尺寸评分）→
渲染子窗口 → 布局动态校准（OCR 找「搜索/发送」锚点，存 `~/.wechatauto/layout-<机器>.json`，
漂移自动重校准）→ WinRT OCR 识别会话列表/输入框/发送按钮 → 真实鼠标事件（SendInput）+
剪贴板 Ctrl+V 输入（防中文输入法拦截，失败回退拼音）→ 点击发送 → verify=True 用 WeChatDB 读回确认。

**v1.2.0 修复**（配套新测试 `test_guia_ocr_temp_path.py`）：
- OCR 硬超时 12s：整段 OCR 放单工作线程（挂起探针防叠僵尸线程），`future.result(timeout=12)`
  拿真正墙钟上限——`asyncio.wait_for` 取消不了已阻塞在 WinRT/COM 的同步调用（38 分钟卡死根因）。
- OCR 临时文件长路径：WinRT `StorageFile` 不接受 8.3 短路径（服务/SYSTEM 上下文 TEMP 常为
  `REMOTE~1` 形式）→ `[Errno 22]` → OCR 永远空 → 发送路径反复重试；现用 `GetLongPathNameW`
  还原长路径 + 按 pid+线程 id 区分临时 PNG。

## 7. SQLite 事件库与配置

- `event_store.py`：默认 `.data/channel-host.sqlite3`（WAL + synchronous=FULL）。
  表：`channel_events`（cursor 自增 PK + event_id 唯一 + 全字段）、`source_checkpoints`、
  `discovered_conversations`、`host_metadata`（epoch/回溯标记）、`channel_send_operations`
  （含 baseline/attempts/lease 列，增量迁移）。
- **环境变量**：`CHANNEL_HOST_TOKEN`（必填）、`CHANNEL_HOST_EVENT_STORE`、
  `CHANNEL_HOST_MEDIA_STAGING`、`CHANNEL_HOST_BIND`（127.0.0.1）、`CHANNEL_HOST_PORT`（43123）、
  `CHANNEL_HOST_POLL_INTERVAL_SECONDS`（1）、`CHANNEL_HOST_MESSAGE_CHAT_DISCOVERY_INTERVAL_SECONDS`
  （30）、`CHANNEL_HOST_SEND_TIMEOUT_SECONDS`（180）、`WECHAT_DB_DIR`、`WECHAT_KEYS_FILE`、
  `WECHAT_ACCOUNT`（ADR-0005）、`WECHAT_IMAGE_KEY(_FILE)`、`WECHAT_IMAGE_KEY_RESCAN_INTERVAL_SECONDS`
  （60）、`WECHAT_MEDIA_ORIGINAL_VIA_UI`（默认关）、`WECHAT_BACKFILL_INCLUDE_GROUPS`（默认 0）、
  `WECHAT_BACKFILL_SINCE_DAYS`（30）、`WECHAT_BACKFILL_BATCH_SIZE`（200）、
  `WECHAT_BACKFILL_BATCH_DELAY_MS`（500）、`WECHAT_BACKFILL_AUTO`（1）。
- **run.ps1**：`-Detached` 开关；从 `../../core/.env` 载入 env（不打印值）；用
  `.venv\Scripts\python.exe`（缺失提示 `uv sync --frozen --no-cache`）；Detached 时后台启动，
  日志 `.data/channel-host.{out,err}.log`。**run-drill.ps1**：演练平行栈（独立 store、端口 43124）。
- **测试**：`channel_host/tests/` 13 文件（backfill/contacts/emotion_pat_account/event_store/
  host_polling/http_host/key_service/media/mention_detection/outbound_reconcile/send_operations/
  sender_semantics/**send_execution_timeout（新）**）+ 仓根 11 个实测脚本 + 演练器
  （drill_backfill / drill_send_local / drill_uia_selfheal / regression_gui_reset / inject_live_event）。
