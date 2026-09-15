-- 0077: 表情包彻底去截图依赖（事件文本化后按纯文本 kind=emotion 落库）。
-- 历史行是旧版 Host 的产物：emotion 带 mediaRef 被 Core 规范成 image，
-- 其媒体是微信窗口屏幕截图。截图链路已下线（Host 不再生成 emotion 的
-- mediaRef，媒体解析一律 failed），这里把历史行改回文本语义，前端按
-- 「[表情包]<含义>」渲染，也不再请求其媒体。
-- 判定保守：只命中「图片类型且正文以 [表情包] 开头」的行（真实图片消息
-- 正文不会是这个形态）。
-- 幂等：可安全重跑。

UPDATE "conversation"."messages"
SET "content_type" = 'emotion'
WHERE "content_type" = 'image'
  AND "text" LIKE '[表情包]%';
