-- WeKnora 桥接账号：weflow 用户 ↔ WeKnora 用户的代管登录凭证
-- 合成密码与访问/刷新令牌均为 AES-256-GCM 密文（KNORA_ACCOUNT_ENC_KEY 派生密钥）
CREATE TABLE "identity"."knora_accounts" (
  "weflow_user_id" varchar(36) PRIMARY KEY REFERENCES "identity"."users"("user_id") ON DELETE cascade,
  "knora_user_id" varchar(36) NOT NULL,
  "knora_email" varchar(255) NOT NULL UNIQUE,
  "password_enc" text NOT NULL,
  "access_token_enc" text,
  "refresh_token_enc" text,
  "tokens_expire_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
