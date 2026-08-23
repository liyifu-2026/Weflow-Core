# 微信图片缩略图回退与 AES 密钥管理设计

日期：2026-08-23
状态：已确认（用户批准）
范围：`runtimes/channel-host-wechat`（Python）+ `core`（TypeScript，仅媒体升级链路）

## 问题

微信 4.x 图片 AES 密钥仅在用户查看大图时驻留 Weixin.exe 进程内存。密钥缺失时：

1. `detect_image_key()` 进入 120s 阻塞监控；请求路径的单遍内存扫描无时间预算，
   多 GB 内存扫描导致媒体请求 >60s 挂死，超过 Core 15s HTTP 超时 → `source_error`。
2. 无密钥 = 完全无图，图片消息静默失败。

老项目经验（`wxbot/wechatbot-new/wxbot.py:216-262`）：缩略图 `<md5>_t.dat`
为整文件单字节 XOR 加密（尾部 JPEG EOI `FF D9` 反推密钥），解密不需要 AES 密钥。

## 目标

- 无 AES 密钥时图片经缩略图在 Console/Mobile 正常显示
- 密钥就绪后自动升级为原图（"查看原图"入口点亮）
- 密钥支持 env/文件注入、启动重扫持久化、显式刷新（账号切换失效）
- 缺密钥快速失败；原图+缩略图都失败才走降级 Turn / 人工路由（Core 既有路径）

## Host 侧设计

### wechatauto/media.py

- 构造参数新增：`keys_file`（覆盖默认 `db.workdir/image_keys.json`）、
  `scan_budget_seconds=8.0`（单次扫描时间预算）、`scan_cooldown_seconds=30.0`
  （未命中冷却）。密钥操作统一 RLock（HTTP 线程/后台线程并发安全）。
- `_scan_aes_key` 改为有界单遍；阻塞式 monitor 循环仅保留 CLI 交互路径
  （`detect_image_key(wait_seconds=...)`）。
- 新增 API：
  - `try_acquire_image_key(force=False) -> bool`：注入 → 持久化 → 有界扫描
    （冷却期内直接跳过）；命中后持久化。
  - `refresh_image_key() -> bool`：清运行缓存 + 探针缓存 + 冷却标记后强制获取；
    账号切换后探针随新账号 .dat 重建，旧密钥校验自然失效。
  - `has_image_key() -> bool`：不触发扫描的可用性检查。
- `monitor_key` 参数更名 `allow_key_scan`（download_image / decrypt_image /
  _decrypt_v2 / _resolve_aes_key 全链路）。
- 新增 `download_image_thumbnail(user, local_id, save_dir=None)`：glob 定位
  `<md5>_t.dat` → 免 AES 解密落盘 `_thumb.jpg/png/gif`；无签名整文件 XOR 格式
  在既有固定候选外增加尾部反推密钥候选；wxgf 容器返回 None。永不抛缺密钥错误。

### channel_host/media.py（resolver）

解析顺序：原图（`allow_key_scan=False`，缺密钥毫秒级 RuntimeError）→ 缩略图回退
→ 双失败返回 `pending`（Core 重试 2 次 → terminal failed → 降级 Turn）。
`ChannelMediaReadResult.ready` 增加 `variant`（`"original"` | `"thumbnail"`）。

### channel_host/key_service.py（新增）

`ImageKeyService(downloader, interval_seconds=60, logger)`：守护线程周期调用
`try_acquire_image_key()`（有密钥时为廉价校验）；仅状态跃迁打日志
（acquired / unavailable），永不输出密钥值；`refresh()` 透传强制刷新。

### channel_host/main.py

读取 `WECHAT_IMAGE_KEY`（单账号显式注入）、`WECHAT_IMAGE_KEYS_FILE`（密钥文件
路径覆盖）注入 MediaDownloader；启动并在退出时停止 ImageKeyService。

### channel_host/http_host.py

- 200 图片响应附带 `X-Media-Variant: original|thumbnail` 头。
- 新增 token 保护端点 `POST /api/v1/channel/media-key/refresh`：调用注入的
  `key_refresh` 回调，返回 `{available}`；未配置回调返回 501。响应不含密钥。

### 安全边界

- 请求路径零内存扫描；扫描只发生在后台服务与显式刷新。
- 密钥仅存于环境变量、`image_keys.json`（加入 `.gitignore`）、进程内存；
  不出现在任何日志/错误消息/Core 事件。

## Core 侧设计

复用既有两层文件模型：`mediaAssets.originalFileId`（展示层 `/content`）+
`originalImageFileId`（全尺寸原图 `/content/original`，为空时前端隐藏"查看原图"）。

1. **契约**（`channel-media-source.ts`）：ready 增加可选
   `variant?: "original" | "thumbnail"`，缺省 original（向后兼容）。
2. **Provider**（`http-channel-provider.ts`）：resolveImage 解析 200 响应的
   `X-Media-Variant` 头，白名单外按 original 处理。
3. **迁移** `0055_media_source_variant.sql`：`media.assets` 增加
   `source_variant varchar(16) NULL`、`upgrade_attempt integer NOT NULL DEFAULT 0`。
4. **syncChannelImages**：
   - ready+original：现状不变，记 `source_variant='original'`。
   - ready+thumbnail：字节写入展示层 `originalFileId`，记
     `source_variant='thumbnail'`，照常 processing_queued —— 视觉用缩略图跑一次，
     Agent Turn 立即创建，用户马上看到图。
5. **升级 pass**（`upgrade-channel-image-originals.ts`，挂进现有 media poller
   tick，syncMedia 之后执行）：
   - 选择 `kind='image' AND status='ready' AND source_variant='thumbnail'
     AND originalImageFileId IS NULL AND nextAttemptAt <= now`，批量 10。
   - 条件 UPDATE 推进 `nextAttemptAt` 作租约 claim，防并发重复抓取。
   - resolveImage 返回 ready+original：写新 storedFile → 事务更新
     `originalImageFileId` 与 `source_variant='original'`；不重跑视觉
     （若视觉尚未完成，process-image-description 自动 join 到新原图）。
   - 非 ready-original 结果或异常：`upgrade_attempt+1`，退避重试（10min 起步，
     封顶 60min）；超过 24h 放弃并置 `errorCode='source_original_unavailable'`，
     已显示缩略图不受影响。

## 明确不做

- Console/Mobile：零改动。
- 升级成功不重跑视觉描述（避免双倍成本；低清描述可接受，原图供人查看）。
- Core 不感知缩略图/原图之外的通道实现细节；wire 上只有 variant 标记。

## 测试计划

Python：resolver 三分支（原图/回退/双失败 pending）、variant 透传；
key_service 状态机与日志脱敏；wechatauto 冷却/预算/refresh/探针失效/
持久化 roundtrip（fake db + 注入校验桩）；http_host refresh 端点鉴权、501、头。

TypeScript：provider 头解析（含非法值回退）；syncChannelImages 双分支与迁移列；
升级 pass 成功/退避/放弃/幂等；既有集成测试回归。

验收对照：
- 无密钥 → 缩略图可显示 ✅（resolver 回退）
- 有密钥 → 自动加载原图 ✅（后台服务 + 升级 pass）
- 超时上限明确、不阻塞轮询 ✅（请求路径零扫描 + 有界预算）
