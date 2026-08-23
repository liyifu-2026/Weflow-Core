# 微信图片缩略图回退与密钥管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 微信图片无 AES 密钥时回退缩略图显示，密钥就绪后自动升级原图；密钥注入/缓存/刷新机制完善且请求路径零阻塞。

**Architecture:** Host 侧（wechatauto + channel_host）负责解密/扫描/密钥存储，请求路径不做内存扫描（原图毫秒级失败 → 缩略图回退 → pending）；后台守护线程负责启动重扫与周期补偿。Core 侧复用 originalFileId/originalImageFileId 两层文件模型，新增 variant 契约字段与升级 pass。

**Tech Stack:** Python 3.12 stdlib + cryptography（Host）；TypeScript + Drizzle + Fastify（Core）。

设计文档：`docs/superpowers/specs/2026-08-23-wechat-image-thumbnail-fallback-design.md`

---

### Task 1: wechatauto 密钥管理重构（有界扫描/冷却/refresh/线程安全）

**Files:**
- Modify: `runtimes/channel-host-wechat/wechatauto/media.py`
- Test: `runtimes/channel-host-wechat/test_media_keys.py`（新建）

- [ ] 写失败测试：冷却期内不重复扫描、force 跳过冷却、refresh 清探针缓存、持久化 roundtrip、has_image_key 不扫描
- [ ] 运行确认失败
- [ ] 实现：`__init__` 新增 `keys_file/scan_budget_seconds=8.0/scan_cooldown_seconds=30.0` + `threading.RLock`；`_key_store()` 优先 `self._keys_file`；`_scan_aes_key(deadline)` 有界单遍（region 循环检查 deadline）；新增 `_current_aes_key()`（注入→持久化，无扫描）、`try_acquire_image_key(force=False)`、`refresh_image_key()`（清 `_img_key/_key_probe/_last_scan_miss`）、`has_image_key()`；`_resolve_aes_key(allow_scan)` 接入冷却
- [ ] 测试通过
- [ ] `monitor_key` → `allow_key_scan` 全链路更名（decrypt_image/_decrypt_v2/_resolve_aes_key/download_image），同步更新调用方

### Task 2: download_image_thumbnail（免 AES 缩略图）

**Files:**
- Modify: `runtimes/channel-host-wechat/wechatauto/media.py`
- Test: `runtimes/channel-host-wechat/test_media_keys.py`

- [ ] 写失败测试：构造整文件 XOR 加密的假缩略图（尾部 FFD9 反推），`download_image_thumbnail` 落盘 `_thumb.jpg`；wxgf 返回 None；无缩略图返回 None
- [ ] 实现：`_find_thumbnail_dat(md5)` glob `<md5>_t.dat`；`download_image_thumbnail`：先尾部反推整文件 XOR（校验 JPEG/PNG/GIF 魔数），失败回退 `decrypt_image(allow_key_scan=False)`，wxgf/未知格式返回 None

### Task 3: resolver 缩略图回退 + variant

**Files:**
- Modify: `runtimes/channel-host-wechat/channel_host/media.py`
- Modify: `runtimes/channel-host-wechat/channel_host/tests/test_media.py`

- [ ] 更新 FakeDownloader 签名（allow_key_scan）+ 新增 download_image_thumbnail 桩
- [ ] 写失败测试：原图成功 variant=original；RuntimeError→缩略图成功 variant=thumbnail；双失败 pending
- [ ] 实现：`ChannelMediaReadResult` 增加 `variant: str = "original"`；resolve 先原图（allow_key_scan=False），RuntimeError/None → 缩略图（独立 staging 目录），双失败清理后 pending

### Task 4: ImageKeyService + main.py 接线

**Files:**
- Create: `runtimes/channel-host-wechat/channel_host/key_service.py`
- Modify: `runtimes/channel-host-wechat/channel_host/main.py`
- Test: `runtimes/channel-host-wechat/channel_host/tests/test_key_service.py`（新建）

- [ ] 写失败测试：启动即扫描、状态跃迁日志（acquired→unavailable→acquired）、refresh 透传、stop 停线程、日志不含密钥值
- [ ] 实现 ImageKeyService（守护线程、立即首扫、interval wait、异常只记类型名）
- [ ] main.py：`WECHAT_IMAGE_KEY`/`WECHAT_IMAGE_KEYS_FILE` 注入 MediaDownloader；key_service.start()/stop()；http_server 传 key_refresh

### Task 5: http_host variant 头 + refresh 端点

**Files:**
- Modify: `runtimes/channel-host-wechat/channel_host/http_host.py`
- Modify: `runtimes/channel-host-wechat/channel_host/tests/test_http_host.py`

- [ ] 写失败测试：ready 响应含 X-Media-Variant；POST /api/v1/channel/media-key/refresh 鉴权 401/未配置 501/正常 200 {available}
- [ ] 实现：ctor `key_refresh` 参数；_write_media 发送头；do_POST 路由

### Task 6: gitignore + README

**Files:**
- Modify: `runtimes/channel-host-wechat/.gitignore`
- Modify: `runtimes/channel-host-wechat/README.zh-CN.md`

- [ ] .gitignore 增加 `image_keys.json`（secrets 注释）
- [ ] README 增补密钥配置/刷新端点/缩略图回退说明

### Task 7: Core 契约 variant + Provider 头解析

**Files:**
- Modify: `core/modules/channel/contracts/channel-media-source.ts`
- Modify: `core/infrastructure/channel/http-channel-provider.ts`（resolveImage）
- Test: 既有 provider 测试文件（实现时定位）

- [ ] 契约：ready 增加可选 `variant?: "original" | "thumbnail"`
- [ ] Provider：解析 `x-media-variant` 头，非 "thumbnail" 一律 original
- [ ] 单测：thumbnail/缺失/非法值三例

### Task 8: 迁移 0055 + schema

**Files:**
- Modify: `core/infrastructure/postgres/schema.ts`（mediaAssets 增 `sourceVariant`/`upgradeAttempt`）
- Create: `core/migrations/0055_media_source_variant.sql`

- [ ] SQL：ADD COLUMN source_variant varchar(16); ADD COLUMN upgrade_attempt integer DEFAULT 0 NOT NULL
- [ ] schema.ts 同步两列；检查迁移 journal 机制并按既有模式登记

### Task 9: syncChannelImages variant 分支

**Files:**
- Modify: `core/modules/media/application/sync-channel-images.ts`
- Test: `core/tests/channel-media-processing.integration.test.ts`（扩展）

- [ ] ready 分支写 `sourceVariant: variant === "thumbnail" ? "thumbnail" : "original"`
- [ ] 集成测试：thumbnail 资产落展示层且 source_variant=thumbnail；original 资产行为不变

### Task 10: 升级 pass + poller 接线

**Files:**
- Create: `core/modules/media/application/upgrade-channel-image-originals.ts`
- Modify: `core/infrastructure/channel/channel-media-poller.ts`（可选 upgradeOriginals 依赖）
- Modify: `core/apps/api/main.ts`（注入）
- Test: `core/tests/channel-media-upgrade.integration.test.ts`（新建）

- [ ] 写失败集成测试：ready+thumbnail 资产 → mock source 返回 original → originalImageFileId 填充、source_variant=original、storedFiles 新行；source 持续 thumbnail → upgrade_attempt 递增 + nextAttemptAt 退避
- [ ] 实现 upgradeChannelImageOriginals（批量 10、nextAttemptAt 等值 CAS 租约、成功写文件+事务更新、失败退避 10min→60min、24h 放弃置 errorCode=source_original_unavailable）
- [ ] poller options 增加可选 upgradeOriginals，pollChannelMediaOnce 顺序调用；main.ts 传入

### Task 11: contracts README + 全量验证

- [ ] `contracts/channel/README.md` 增补 X-Media-Variant 语义
- [ ] Python：`.venv` unittest discover 全绿
- [ ] Core：`pnpm typecheck` + 相关 test 全绿
