/**
 * 头像选择与上传 Hook
 * 供「账号与设备」页与信息名片页复用：相册选图 → 上传 Core → 更新本地会话缓存。
 */
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Alert } from "react-native";
import { uploadAvatar } from "./api";
import { saveSession, type MobileSession } from "./session";

/** 返回头像上传状态与选择上传动作 */
export function useAvatarUpload(
  session: MobileSession | undefined,
  onSessionUpdate: (session: MobileSession) => void,
): { uploading: boolean; pickAndUploadAvatar: () => Promise<void> } {
  const [uploading, setUploading] = useState(false);

  /** 选择图片并上传为新头像（成功后立即更新本地会话缓存） */
  async function pickAndUploadAvatar() {
    if (!session || uploading) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("需要相册权限", "请在系统设置中允许访问照片。");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    const mimeType = asset.mimeType ?? "image/jpeg";
    setUploading(true);
    try {
      const { avatarUrl } = await uploadAvatar(session, {
        uri: asset.uri,
        mimeType,
        fileName: `avatar.${mimeType.split("/")[1] ?? "jpg"}`,
      });
      const updated: MobileSession = {
        ...session,
        user: { ...session.user, avatarUrl },
      };
      await saveSession(updated);
      onSessionUpdate(updated);
    } catch (reason) {
      Alert.alert(
        "上传失败",
        reason instanceof Error ? reason.message : "请稍后重试。",
      );
    } finally {
      setUploading(false);
    }
  }

  return { uploading, pickAndUploadAvatar };
}
