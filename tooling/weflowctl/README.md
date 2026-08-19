# weflowctl

Weflow 命令行工具。当前提供 Solution Pack 基础命令：

```bash
weflowctl solution validate --manifest solution.manifest.json --lock solution.lock.json
weflowctl solution plan --manifest solution.manifest.json --lock solution.lock.json --platform 1.2.0
weflowctl solution install --manifest solution.manifest.json --lock solution.lock.json --signature signature.json --core-url http://localhost:3000 --admin-token <token>
```

当前输入为 JSON；后续可加 YAML 支持。
