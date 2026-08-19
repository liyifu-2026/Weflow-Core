# Channel contracts

Channel 是入口适配层。Core 不知道入口来自微信、企业微信、飞书、邮件还是 Web；它只消费统一的 Conversation Event，并通过能力契约发送消息或解析媒体。

## Formal capabilities

### `channel.events`

按不透明游标增量拉取标准化事件。事件包含 `eventId`、`cursor`、`conversationRef`、`channelMessageId`、`senderRef`、`kind`、`content`、`mediaRef`、时间和 `isSelf`。Core 只保存和推进协议游标，不解释 Provider 的内部 ID。

### `channel.send`

以 `operationId` 创建幂等出站操作，并通过同一 ID 查询结果。状态包括 `pending`、`confirmed`、`unknown`、`failed`。`unknown` 表示外部发送结果不可确定，不能被静默改写成成功或失败。

### `channel.media`

以事件中的不透明 `mediaRef` 请求媒体。微信 `local_id`、数据库路径和源文件可用性只属于 Channel Host/Driver；Core 只得到可持久化的媒体流或明确的 `pending`、`not_found`、`failed` 结果。

### `channel.contacts`

按不透明 `contactRef` 游标分页读取标准化联系人资料。微信联系人表、列名、头像来源和本地数据库路径只属于 Channel Host/Driver；Core 只接收联系人身份展示字段并维护 Contact Profile。

## Implementation model

Channel Capability 是平台级抽象，不绑定任何具体入口。Core 只依赖正式 Channel Capability，通过 `infrastructure/channel` 的 Provider 接入具体通道实现；具体通道实现（如微信 Channel Host/Driver）不属于本仓库，由外部适配器提供，负责把入口私有细节转换为上述契约。

旧运行时名称和旧 Connector 仅在
`docs/migration/phase-2-legacy-names.md` 中作为历史说明出现，不属于可执行代码。
