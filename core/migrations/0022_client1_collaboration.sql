ALTER TABLE "handoff"."cycles" ADD COLUMN "assigned_queue_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "handoff"."states" ADD COLUMN "assigned_queue_id" varchar(36);
--> statement-breakpoint
CREATE SCHEMA "collaboration";
--> statement-breakpoint
CREATE TABLE "collaboration"."specialist_queues" (
  "queue_id" varchar(36) PRIMARY KEY NOT NULL,
  "key" varchar(80) NOT NULL UNIQUE,
  "display_name" varchar(120) NOT NULL,
  "description" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collaboration"."queue_members" (
  "membership_id" varchar(36) PRIMARY KEY NOT NULL,
  "queue_id" varchar(36) NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "queue_members_queue_user_unique" UNIQUE("queue_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE "collaboration"."requests" (
  "request_id" varchar(100) PRIMARY KEY NOT NULL,
  "conversation_id" varchar(300) NOT NULL,
  "handoff_cycle_id" varchar(100) NOT NULL,
  "kind" varchar(20) NOT NULL,
  "status" varchar(20) NOT NULL,
  "queue_id" varchar(36) NOT NULL,
  "created_by_user_id" varchar(36) NOT NULL,
  "claimed_by_user_id" varchar(36),
  "reason" text NOT NULL,
  "resolution" text,
  "client_request_id" varchar(36) NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone,
  "answered_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collaboration"."request_participants" (
  "participant_id" varchar(36) PRIMARY KEY NOT NULL,
  "request_id" varchar(100) NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "left_at" timestamp with time zone,
  CONSTRAINT "collaboration_participants_request_user_unique" UNIQUE("request_id", "user_id")
);
--> statement-breakpoint
ALTER TABLE "collaboration"."queue_members" ADD CONSTRAINT "queue_members_queue_fk" FOREIGN KEY ("queue_id") REFERENCES "collaboration"."specialist_queues"("queue_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration"."queue_members" ADD CONSTRAINT "queue_members_user_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration"."requests" ADD CONSTRAINT "collaboration_requests_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"."conversations"("conversation_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration"."requests" ADD CONSTRAINT "collaboration_requests_cycle_fk" FOREIGN KEY ("handoff_cycle_id") REFERENCES "handoff"."cycles"("cycle_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration"."requests" ADD CONSTRAINT "collaboration_requests_queue_fk" FOREIGN KEY ("queue_id") REFERENCES "collaboration"."specialist_queues"("queue_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration"."requests" ADD CONSTRAINT "collaboration_requests_creator_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration"."requests" ADD CONSTRAINT "collaboration_requests_claimer_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration"."request_participants" ADD CONSTRAINT "collaboration_participants_request_fk" FOREIGN KEY ("request_id") REFERENCES "collaboration"."requests"("request_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration"."request_participants" ADD CONSTRAINT "collaboration_participants_user_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "collaboration_requests_conversation_idx" ON "collaboration"."requests" USING btree ("conversation_id", "created_at");
--> statement-breakpoint
CREATE INDEX "collaboration_requests_queue_status_idx" ON "collaboration"."requests" USING btree ("queue_id", "status");
--> statement-breakpoint
INSERT INTO "collaboration"."specialist_queues" ("queue_id", "key", "display_name", "description") VALUES
  ('queue-product-use', 'product_use', '产品使用', '产品功能、安装和操作问题'),
  ('queue-software-account', 'software_account', '软件与账号', '软件、登录、权限和账号问题'),
  ('queue-device-fault', 'device_fault', '设备故障', '硬件故障、异常和维修判断'),
  ('queue-rf', 'rf', '射频技术', '射频、信号和连接问题'),
  ('queue-acoustics', 'acoustics', '声学技术', '声学、音频和噪声问题'),
  ('queue-after-sales', 'after_sales', '售后与投诉', '售后、退款、投诉和升级处理'),
  ('queue-other', 'other', '其他', '暂时无法判断专业归属的问题');
