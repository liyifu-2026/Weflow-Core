/**
 * 敏感数据存储实例
 * 根据当前平台创建安全存储：iOS/Android 使用 SecureStore，Web 使用内存存储。
 */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { createSensitiveStorage } from "./sensitive-storage-core";

export const sensitiveStorage = createSensitiveStorage(
  Platform.OS,
  SecureStore,
);
