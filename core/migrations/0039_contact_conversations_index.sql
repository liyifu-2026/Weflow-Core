-- 联系人历史会话查询索引
-- 支持 GET /api/v1/contacts/:contactId/conversations 按 contactId 游标分页
CREATE INDEX IF NOT EXISTS "conversations_contact_id_idx"
  ON "conversation"."conversations" ("contact_id");
