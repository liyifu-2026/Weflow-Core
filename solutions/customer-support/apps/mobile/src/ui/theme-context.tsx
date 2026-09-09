/**
 * 主题上下文模块
 * 通过 React Context 提供主题色彩和深色模式状态。
 * 自动跟随系统深色/浅色模式切换。
 */
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import { darkColors, lightColors, type ThemeColors } from "./theme";

export type ThemeMode = "system" | "light" | "dark";
const THEME_KEY = "mobile.theme.mode";

/** 主题上下文值类型 */
type ThemeValue = {
  colors: ThemeColors;
  isDark: boolean;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeValue>({
  colors: lightColors,
  isDark: false,
  mode: "system",
  setMode: () => undefined,
});

/** 主题提供者组件，自动检测系统深色模式并切换色彩方案 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemIsDark = useColorScheme() === "dark";
  const [mode, setModeState] = useState<ThemeMode>("system");
  useEffect(() => {
    void SecureStore.getItemAsync(THEME_KEY).then((value) => {
      if (value === "system" || value === "light" || value === "dark") {
        setModeState(value);
      }
    });
  }, []);
  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void SecureStore.setItemAsync(THEME_KEY, next);
  }, []);
  const isDark = mode === "dark" || (mode === "system" && systemIsDark);
  const value = useMemo(
    () => ({
      colors: isDark ? darkColors : lightColors,
      isDark,
      mode,
      setMode,
    }),
    [isDark, mode, setMode],
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/** 获取当前主题值（色彩方案和深色模式状态） */
export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/** 创建响应主题变化的样式，色彩方案变化时自动重新计算 */
export function useThemedStyles<T>(factory: (colors: ThemeColors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => factory(colors), [colors, factory]);
}
