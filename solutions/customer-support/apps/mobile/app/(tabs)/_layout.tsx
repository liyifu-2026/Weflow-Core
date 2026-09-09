/**
 * Agent → Human Handoff Console 的唯一工作入口。
 * 这里不再使用底部导航；会话详情通过 Stack push 打开。
 */
import { router, Stack } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { loadSession } from "@/auth/session";
import { useTheme } from "@/ui/theme-context";

export default function WorkLayout() {
  const { colors } = useTheme();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    void loadSession().then((session) => {
      if (!session) router.replace("/");
      else if (session.user.mustChangePassword) router.replace("/change-password");
      setChecked(true);
    });
  }, []);

  if (!checked) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }} />;
}
