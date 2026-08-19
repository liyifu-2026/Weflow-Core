# Core Agent Guide

This file guides engineering agents changing Weflow Core. Read `CONTEXT.md` for
domain language and `docs/adr/` for accepted architectural decisions before
altering behaviour.

## System boundaries

- **Channel Host** owns channel transport facts: login, inbound channel events,
  channel media access, sending, and delivery operation confirmation.
- **Core** owns business facts: conversations, messages, Agent Turns,
  handoffs, contact profiles, memory, media metadata, and audits.
- **Console** and Solution-provided clients are authenticated management
  clients. They do not own business state or bypass Core APIs.
- There is one shared workspace. An end-user contact is not a logged-in user.

Never move business logic into the Channel Host, use a Redis queue as a source of
truth, or infer incoming messages from UI state, unread counts, or pagination.

## Runtime and module shape

- `apps/api` hosts authenticated HTTP APIs, the Channel Host poller, and durable
  dispatchers.
- `apps/agent-worker` runs Agent Turns and memory capture with bounded global
  concurrency and per-conversation serialization.
- `apps/ingestion-worker` is the media worker and processes inbound media.
- `modules/*/application` contains business use cases; `interface` contains
  HTTP adapters; `infrastructure` contains PostgreSQL, Redis, model, storage,
  Channel Host, and runtime adapters.

Keep application services independent of Fastify requests, environment
variables, and provider-specific payloads. Put provider protocol translation
in infrastructure adapters.

## PostgreSQL, transactions, and queues

- PostgreSQL is the only durable business source of truth. Redis/BullMQ jobs
  are recoverable delivery hints and must be rebuildable from PostgreSQL.
- Persist business facts transactionally before enqueueing or sending.
- Use stable IDs and idempotency keys for Agent Turns, tool executions,
  messages, Handoff events, and Channel Host operations.
- Re-read Handoff state before model calls where practical, before Case
  writes, before tools, and before creating outbound messages.
- Use Case `revision` optimistic locking; an old Turn must become
  `superseded`, never overwrite newer state.
- Add a numbered SQL migration and journal entry for every schema change.
  Do not rewrite an applied migration.

## Conversation and outbound delivery

- Inbound Channel Host events are idempotent. Do not change cursor or message
  uniqueness semantics without updating the connector recovery path.
- A Conversation serializes its Agent work. Different Conversations may run
  in parallel.
- Coalesce only queued Turns; never cancel a running model request merely
  because a new message arrived.
- Agent replies may contain one to three complete `reply_segments`. Persist
  each segment as a separate outbound Message with a stable reply batch ID and
  sequence; never split text by arbitrary characters or sentences.
- Send segments in sequence. Do not process a later Agent Turn for that
  Conversation while an earlier Agent reply batch is pending, submitting, or
  unknown.
- A model response is only a draft. Channel Host delivery must use the persisted
  operation ID and reconcile `unknown`; do not create a replacement operation
  ID automatically.

## Agent, strategy, and context

- Execution Strategy (registered in `ExecutionStrategyRegistry` by Solution
  plugins) decides how a model request is built, how the response is parsed,
  and which actions are validated. It never calls the model, the database, the
  Channel, or tools directly.
- `agent-context` assembles facts. It does not decide strategy or call a model.
- The System Prompt is provided by the selected Execution Strategy; without an
  active strategy, the built-in generic platform prompt is used.
- A new Agent Turn binds the Execution Strategy and Skill set resolved from the
  active execution profile at execution time. Queued and running Turns must
  continue with their bound selection even if the profile changes.
- Skills are looked up through `SkillRegistry` only; they are registered by
  Solution plugins, never hardcoded into Core. Audit each profile change.
- Prompt examples improve style only. Enforce safety, length, segment count,
  state transitions, tool permissions, and idempotency in code.
- Context must distinguish trusted tool facts, human-confirmed profile data,
  end-user statements, confirmed memory, knowledge evidence, visual
  observations, and model inference. Never promote an inference to a
  confirmed fact without a controlled workflow.
- Image descriptions are observations, not certainties. Do not reply to an
  image from its placeholder; wait for the vision-derived description.
- `no_action` is terminal and auditable: persist its reason and do not create
  an outbound Message.

## Tools and Handoff

- A tool plan is not a completed action. Validate its name and arguments,
  execute idempotently, and only then permit a final reply based on its result.
- Do not claim a tool succeeded when it failed, timed out, or has no trusted
  result.
- Handoff is Conversation-scoped. It pauses new Agent Turn creation, Case
  mutation, automatic tools, and automatic outbound messages for that one
  Conversation only; other Conversations continue normally.
- Creating a Handoff cancels pending Agent drafts and sends the configured,
  program-controlled acknowledgement. Never let the model freely phrase a
  high-risk handoff acknowledgement.
- A model request already in flight may finish, but its result must be
  suppressed after Handoff. Resolving Handoff does not replay old drafts or
  paused Turns.

## Memory, knowledge, and media

- Memory capture is asynchronous and uses a durable watermark/revision.
  Only active, evidence-backed, non-sensitive memory is recalled.
- Knowledge answers require retrievable, attributable evidence. Do not invent
  sources or treat WeKnora documents as ready before its parsing completes.
- WeKnora owns knowledge files, parsing, indexes, and retrieval. Core calls
  only its scoped retrieval API through `WeKnoraKnowledgeClient`; it must not
  invoke WeKnora Agent, Chat, or IM endpoints, which would bypass Core
  policy, Handoff, and outbound-delivery controls.
- A WeKnora API key authorizes access; when no Core allow-list is configured,
  discover and search only the knowledge bases visible to that key. Keep the key
  in a secret file and persist returned source evidence with the Tool Execution.
- Media files remain in file storage; Conversations reference media IDs and
  derived descriptions, never base64 payloads.

## API, security, and audit

- All business routes require `requireBusinessIdentity`; preserve password
  change restrictions and audit meaningful mutations with the acting user and
  source IP.
- Validate HTTP input with Zod. Validate model output with the Agent decision
  schema. Reject unknown actions and fields rather than guessing.
- Do not expose secrets, session tokens, raw media paths, hidden prompt
  content, internal memory, or model reasoning in end-user-facing messages.

## Verification

- Add focused regression tests for changed business behaviour. Include
  idempotency, race, Handoff, and retry paths whenever they are affected.
- Run `pnpm typecheck`, targeted `pnpm test`, lint, and formatting checks from
  `core`. The repository targets Node.js 24; report environment version
  mismatches rather than masking them.
- Keep migrations, schema definitions, route contracts, and tests aligned.
- Do not use destructive Git commands or overwrite unrelated workspace
  changes.
