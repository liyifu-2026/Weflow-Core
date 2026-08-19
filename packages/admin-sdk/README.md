# @weflow/admin-sdk

Weflow Admin SDK，供 Console、Solution Runner 与运维工具调用 Core 管理 Interface。

当前包含：

- `AdminClient` 接口
- Solution / Operation 管理类型
- 最小运行时响应校验器

约束：所有响应执行运行时校验，不允许页面自行声明未经验证的类型。
