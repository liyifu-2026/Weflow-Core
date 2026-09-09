# Mobile Android 发布前置

Phase 6.0 已将 Expo、Android namespace、applicationId、Manifest scheme 和 Java/Kotlin 包路径统一为：

```text
slug: weflow-mobile
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

当前工作区中的 Firebase 配置仍属于旧 Android 身份，只作为历史本地配置保留；在新文件提供前，不执行 Android 发布验收，也不把旧配置改写成新包名。
