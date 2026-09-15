/**
 * Metro 将 svg 视为静态资源（resolver.assetExts），导入值是资源 ID（number）。
 * 为 TS 补模块声明；运行时经 Image source={{ uri: number }} 渲染（expo-image 支持）。
 */
declare module "*.svg" {
  const asset: number;
  export default asset;
}
