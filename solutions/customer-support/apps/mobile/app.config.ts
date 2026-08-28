import type { ConfigContext, ExpoConfig } from "expo/config";
import appJson from "./app.json";

/**
 * Release builds fail during Expo config evaluation when Core is not HTTPS.
 * Development must opt into cleartext explicitly instead of inheriting it.
 */
export default function defineExpoConfig({ config }: ConfigContext): ExpoConfig {
  const profile = process.env.EAS_BUILD_PROFILE;
  const releaseBuild = profile === "preview" || profile === "production";
  const apiBaseUrl =
    process.env.EXPO_PUBLIC_API_BASE_URL ??
    String(appJson.expo.extra.apiBaseUrl);
  const allowInsecureHttp =
    !releaseBuild &&
    process.env.EXPO_PUBLIC_ALLOW_INSECURE_HTTP === "true";

  if (releaseBuild && !apiBaseUrl.startsWith("https://")) {
    throw new Error("Preview and production builds require an HTTPS Core endpoint");
  }

  return {
    ...config,
    ...appJson.expo,
    name: "Weflow",
    extra: {
      ...appJson.expo.extra,
      apiBaseUrl,
      allowInsecureHttp,
    },
    plugins: appJson.expo.plugins.map((plugin) =>
      Array.isArray(plugin) && plugin[0] === "expo-build-properties"
        ? [
            plugin[0],
            {
              ...(plugin[1] as object),
              android: { usesCleartextTraffic: allowInsecureHttp },
            },
          ]
        : plugin,
    ) as ExpoConfig["plugins"],
  } as ExpoConfig;
}
