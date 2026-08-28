/**
 * API 基础配置模块
 * 从 Expo 项目配置中读取 Core 的 API 基础地址，并强制 HTTPS 安全策略。
 */
import Constants from "expo-constants";

/** Expo extra 配置中 API 相关字段的类型 */
type ExtraConfig = { apiBaseUrl?: string; allowInsecureHttp?: boolean };

const extra = (Constants.expoConfig?.extra ?? {}) as ExtraConfig;

/** Core API 基础地址，默认值为无效占位地址 */
export const apiBaseUrl = extra.apiBaseUrl ?? "https://api.example.invalid";

// 安全校验：非局域网测试环境下必须使用 HTTPS 协议
if (
  !apiBaseUrl.startsWith("https://") &&
  !(
    __DEV__ &&
    extra.allowInsecureHttp === true &&
    apiBaseUrl.startsWith("http://")
  )
) {
  throw new Error("Mobile API base URL must use HTTPS outside explicit development builds");
}
