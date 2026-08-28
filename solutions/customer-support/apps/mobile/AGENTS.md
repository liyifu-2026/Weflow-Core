# Repository Guidelines

## Project Structure & Source of Truth

Mobile is an Expo React Native application for internal customer-service staff. Use the intended layout as the app is created:

- `app/` holds Expo Router routes and page composition.
- `src/api/` owns Core HTTP contracts and error mapping.
- `src/auth/`, `src/conversations/`, and `src/handoffs/` own feature logic.
- `src/collaboration/` owns specialist-queue assistance and escalation flows.
- `src/notifications/`, `src/media/`, and `src/ui/` contain Push, media, and shared UI.
- `docs/mobile-spec.md` defines product rules and Core contract requirements.
- `docs/mobile-ui-spec.md` defines information architecture and interaction behavior.
- `docs/versioning.md` defines the mandatory versioning and release-note workflow.
- `CHANGELOG.md` is the public record of unreleased and released changes.

`README.md` is broader product context. Core is the source of truth: never place Handoff ownership, queue membership, assistance, escalation, or authorization solely in client state.

Mobile 的设计应接近专业人士每天使用的高级移动应用，而不是管理后台：可读性优先于装饰，交互优先于动画，层级优先于密度，平静优先于刺激，速度优先于视觉效果。每个动画必须表达状态，每种颜色必须表达语义，每次点击都应减少用户工作量。

本地草稿和离线缓存属于敏感业务数据：必须按账号隔离、加密存储、遵守生命周期和容量限制；不得进入未受保护的系统备份、通知正文、日志、截图或 URL。

## Build, Test, and Development Commands

Use the npm scripts declared in `package.json`:

```sh
npm run start    # launch Expo development server
npm run android  # open the Android development target
npm run ios      # open the iOS development target (macOS required)
npm run web      # launch the web target
npm run lint     # run static checks
npm run typecheck # validate TypeScript
npx expo export --platform web # verify Metro/static routing can bundle
```

No automated test suite exists yet. Add tests with each feature and document the command in `README.md`.

## Coding Style & Naming

Use TypeScript and 2-space indentation. Use `camelCase` for values/functions and `PascalCase` for components/types. Keep protocol logic in `src/api/`; pages compose UI and hooks. Run linting before submitting.

## Testing Guidelines

Place tests next to their feature or in the chosen test directory. Name tests by behavior, e.g. `acceptHandoff rejects already-claimed work`. Cover races: conflicts refresh to read-only; retries reuse `clientRequestId`; output is never duplicated.

## Security & Configuration

Persist mobile tokens only in Expo SecureStore, never AsyncStorage, logs, URLs, screenshots, or fixtures. Use fixed HTTPS Core endpoints. Do not reveal customer content, tokens, passwords, prompts, or stack traces.

## Commit & Pull Request Guidelines

No Git history is present. Use concise imperative commits, e.g. `feat: add handoff claim screen`. PRs should describe behavior, link a spec or issue, list tests, include mobile screenshots for UI changes, and state Core dependencies.

## Versioning & Release Notes

Treat version updates as normal project work. For every user-visible feature, Core contract, migration, security, or dependency change, update `CHANGELOG.md` before handoff. Follow `docs/versioning.md` for semantic versioning, release cutover, and validation.
