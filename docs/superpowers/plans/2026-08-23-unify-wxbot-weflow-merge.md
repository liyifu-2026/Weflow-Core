# Unify wxbot tree into We repo

Status: plan

## Goal

Make `C:\Users\12991\Desktop\We\weflow` the single canonical workspace, carrying over
the remaining wxbot-side features that are not yet present.

## Inventory of missing pieces

### 1. npm-style Solution Store / Registry
wxbot has:
- `infrastructure/solutions/solution-store.ts`
- `solution-pack.ts`
- `solution-registry*.ts`
- `solution-update*.ts`
- `solution-executor.ts`
- `tooling/weflowctl.ts` (store commands: publish/install/activate/update/rollback/list/prune)
- Registry read auth

We repo currently has:
- Core operation queue install model (`/api/v1/admin/solution-operations`)
- `tooling/weflowctl` CLI for validate/plan/install/upgrade/rollback/status/health/logs/diff/secrets

Decision needed: port the store/registry model into We `core/modules/solution`, or keep
the operation-queue model and add the missing registry/store pieces on top.

### 2. support-web V2 工作台
wxbot solution has 41 files not present in We solution:
- `views/ConversationsV2.vue`
- `views/KnowledgeV2.vue`
- `views/PoliciesV2.vue`
- `views/CoachV2.vue`
- `views/AiEmployeesView.vue`
- `views/AiEmployeeBindingsView.vue`
- `views/OverviewV2.vue`
- stores/knowledge-workspace.ts
- stores/conversation-workspace.ts
- stores/strategy-workspace.ts
- auth-store.ts
- entries/console-extension.ts
- router.ts
- knowledge/* components
- components/VoiceMessage.vue, WfIcon.vue, WfInspector.vue, etc.
- styles/console-shared.css

We solution currently has only:
- `views/ConversationsView.vue`
- `views/PromptManager.vue`

### 3. Mobile App
wxbot has `apps/mobile` (Expo/React Native).
We solution has no mobile source, only `artifacts/mobile.tgz`.

### 4. Console ExtensionHost 新架构
wxbot Console has:
- `src/weflow/extensions/ExtensionHostView.vue`
- async `mount` contract returning `Promise<{unmount,navigate}>`
- `/solution-assets` proxy
- extension store / matchExtension / bridge
- catch-all extensionHost route

We Console currently has older `apps/console/src/weflow/views/ExtensionHost.vue`.

### 5. Other wxbot platform fixes
- Registry read auth
- Support-web auth fallback / workspace reactivity (if V2 is ported, these come with it)
- `tsconfig` modules include (already merged)
- Nickname-first search (already merged)
- Emotion full chain (already merged)

## Proposed merge order

1. **Platform first**: npm-style Solution Store/Registry into We core + CLI
2. **Console ExtensionHost 新架构** into We apps/console
3. **support-web V2** into We solution, replacing old ConversationsView/PromptManager
4. **Mobile App** into We solution
5. **Full regression + tests**
