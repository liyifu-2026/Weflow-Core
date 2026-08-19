# @weflow/consumer-fixture

外部消费者 fixture，验证外部项目只使用公开 exports 即可编译、测试和运行。

- `src/index.ts`：以包名 `@weflow/contracts`、`@weflow/plugin-sdk`、`@weflow/admin-sdk` 做类型消费。
- `tests/consumer.test.ts`：直接消费各包 `dist` 公共入口，验证运行时行为。

后续接入统一 workspace 后，可改为真正的 `file:`/`workspace:` 依赖。
