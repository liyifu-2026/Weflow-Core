/**
 * 图片上传前的统一预处理。
 * 长边超过 MAX_IMAGE_DIMENSION 的原图等比缩到上限再上传：
 * 移动网络上传更快、内存峰值更低；输出统一转 JPEG（顺带归一化 HEIC）。
 * 尺寸在上限内的图片原样直传，不做多余转码。
 */
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/** 上传图片长边上限（px）：手机屏幕全宽 + 2x 密度足够清晰 */
export const MAX_IMAGE_DIMENSION = 2048;

export type PickedImageAsset = {
  uri: string;
  width?: number | null;
  height?: number | null;
  fileName?: string | null;
  mimeType?: string | null;
};

export type PreparedImage = {
  uri: string;
  fileName: string;
  mimeType: string;
};

export async function prepareImageForUpload(
  asset: PickedImageAsset,
): Promise<PreparedImage> {
  let uri = asset.uri;
  let fileName = asset.fileName ?? `image-${Date.now()}.jpg`;
  let mimeType = asset.mimeType ?? "image/jpeg";

  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  const longest = Math.max(width, height);
  if (longest > MAX_IMAGE_DIMENSION) {
    const context = ImageManipulator.manipulate(asset.uri).resize(
      width >= height
        ? { width: MAX_IMAGE_DIMENSION }
        : { height: MAX_IMAGE_DIMENSION },
    );
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({
      compress: 0.8,
      format: SaveFormat.JPEG,
    });
    uri = saved.uri;
    mimeType = "image/jpeg";
    fileName = `${fileName.replace(/\.\w+$/, "") || `image-${Date.now()}`}.jpg`;
  }
  return { uri, fileName, mimeType };
}
