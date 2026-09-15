# Mobile Android 发布前置

Phase 6.0 已将 Expo、Android namespace、applicationId、Manifest scheme 和 Java/Kotlin 包路径统一为：

```text
slug: weflow-client1
scheme: weflow-mobile
applicationId: com.weflow.mobile
```

Android 发布前必须从 Firebase 下载新的 `google-services.json`，并确认其中：

```json
{
  "client": [{
    "client_info": {
      "android_client_info": {
        "package_name": "com.weflow.mobile"
      }
    }
  }]
}
```

2026-09-07 更新：当前 `google-services.json` 已确认包含 `"package_name": "com.weflow.mobile"`（project_id: clientpe-cfe33），与新 Android 身份一致，Firebase 配置阻塞已解除，可执行 Android 发布验收。
