# 微信文件消息归一化为 file 媒体事件 — 设计

日期：2026-08-23
状态：已确认（用户调整稿）

## 背景与事实核对

- 目标：微信「文件」消息可被 Core 查看/处理，链路为
  `Channel Host 事件(kind=file, mediaRef) → Core media.assets(kind=file) → Channel Host media 端点 → FileStorage`。
- 事实核对：当前仓库（含全部 git 历史）中**不存在** `kind=merge` 的事件流。
  `host.py` 仅捕获 text(type 1)/image(type 3)；type-49（"文件/链接/卡片"，含文件附件、
  合并转发、链接、小程序等）消息被静默跳过。因此本设计是**新增**文件类 49 消息的
  归一化捕获；「解析失败保留原始 merge 事件」在本仓库的等价语义是**维持现状：
  不捕获、不伪造文件事件**。

## 边界与解耦

- WeChat 协议/XML/本地路径/下载只属于 Channel Host（`runtimes/channel-host-wechat`）。
- Core 只见 Provider-Neutral 字段：`kind=file`、`mediaRef`、`fileName`、`mimeType`。
- Console / Solution 只通过 `mediaId` 查看文件，不解析 merge XML；
  不为本能力新增业务页面或修改 Solution manifest。

## Channel Host 改动

### host.py（事件 kind 归一化）
- 新增 `_is_file_message()`：type/local_type 为 49/"文件/链接/卡片" 且 content XML 中
  `<appmsg><type>6</type>`（文件附件）。
- 解析 `<title>` 得真实文件名：剥离路径分隔符与控制字符、限长（256）；同时用
  `mimetypes.guess_type` 推导 mimeType（无法推导则为 null）。
- 产出事件：`kind="file"`、`content=<文件名>`、`mediaRef=wechat-media:v1:{sha256(event_id)}`
  （与 image 同方案，重启稳定）、`fileName=<文件名>`、`mimeType=<guess|null>`。
- 解析失败 / 非 type6 / 文件名为空 → 维持跳过并推进 checkpoint（不伪造文件）。

### event_store.py（mediaRef 持久化与读取）
- `channel_events` 经既有 `_ensure_channel_event_columns` 模式增量加列
  `file_name TEXT`、`mime_type TEXT`（老库自动迁移）。
- `find_image_source(media_ref)` 泛化为 `find_media_source(media_ref)`：
  返回 conversationRef/channelMessageId/kind，不再限定 kind='image'。
- `pull()` 输出仅在存在时带 `fileName`/`mimeType`。

### media.py + http_host.py（媒体端点）
- `create_media_resolver(event_store, downloader, staging_root)` 统一入口：
  查 `find_media_source` 后按 kind 分发 `download_image` / `download_file`。
  文件 mime 用 `mimetypes.guess_type(实际落盘路径)`，兜底 `application/octet-stream`；
  pending/not_found/failed 语义与 image 一致。
- `_write_media` 放宽为「resolver 给什么 mime 发什么」（图片白名单仍由 resolver 端
  `_image_mime_type` 与 Core `resolveImage` 双重保证）；附 `Content-Disposition`
  文件名；沿用 25MB 上限（超限诚实返回 media_too_large）。
- main.py 接线改为统一 resolver。

## Core 改动（Provider-Neutral）

### 契约与 Provider
- `channel-event-source.ts`：`ChannelEvent` 增加可选 `fileName?`、`mimeType?`。
- `channel-media-source.ts`：接口增加 `resolveFile(mediaRef)`。
- `http-channel-provider.ts`：host 事件 schema 增加可选字段（additive）；
  实现 `resolveFile`（同一 `/api/v1/channel/media/:mediaRef`，不做图片 mime 白名单）。
  注意：Core schema 是 `.strict()`，Host 与 Core 需同步部署。

### ingest（conversations/application/ingest-channel-events.ts)
- `kind="file"` 合法且必须有 `mediaRef`（同 image 规则，否则拒绝该事件）。
- kind=file 入站时创建 `media.assets(kind="file", sourceMediaRef, status=queued)`。
- `messages.channelType`：file→49；`contentType`="file"；`text`=文件名（非 XML）。
- Agent Turn 维持现有规则（file 属非图片入站，照常建 Turn）。

### 媒体同步（modules/media/application/sync-channel-images.ts → syncChannelMedia）
- 扫描 kinds ["image","file"]；按 kind 选 `resolveImage`/`resolveFile`。
- **文件无视觉描述阶段**：下载成功直接 `status="ready"`（避免永久滞留
  processing_queued）；失败复用既有重试/failed/errorCode 路径。
- 存储扩展名由 mime 映射，未知 mime 兜底 `.bin`。
- dispatcher 无需改动（describe 仅针对 image；file 不进 processing_queued）。
- 失败降级诚实：消息文本始终是文件名而非 XML；asset failed 带 errorCode，
  媒体端点按状态返回 not_ready/not_found。

## 测试计划

Host（unittest）：
- merge 文件（49+XML type6）→ `kind=file` + 稳定 mediaRef + fileName/mimeType；
  重启后 ref 稳定；XML 不出现在 content。
- 非文件 49（合并转发 type19 / 链接 type5 / 坏 XML）→ 仍跳过，不产生事件。
- file resolver：ready/pending/not_found 分支；HTTP 端点输出文件流与 Content-Type。

Core（vitest）：
- ingest：kind=file 建 media.assets(kind=file)、text=文件名（镜像 image 集成测试）。
- sync：file 资产经 resolveFile → FileStorage → status=ready（镜像 image 同步测试）。

## 明确不做

- 不实现 merge/链接/小程序等其它 49 子类事件的捕获（后续需另立 ADR）。
- 不改 outbound（发送侧仍仅 text）。
- Console 文件卡片 UI 渲染属客户端关注点，不在本设计内。
