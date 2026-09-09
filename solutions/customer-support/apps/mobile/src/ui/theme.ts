/**
 * 主题色彩系统模块
 * 定义浅色和深色两套语义化色彩方案，所有颜色通过语义名称引用。
 * 语义名称（如 canvas、paper、ink）表达用途而非具体色值。
 */
/** 浅色模式色彩方案 */
export const lightColors = {
  canvas: "#F7F7F5",
  paper: "#FFFFFF",
  ink: "#18181B",
  muted: "#71717A",
  rule: "rgba(24,24,27,0.08)",
  navy: "#18181B",
  primary: "#315B8F",
  onPrimary: "#FFFFFF",
  blue: "#315B8F",
  blueWash: "#EDF3F8",
  orange: "#9A641C",
  orangeWash: "#FAF2E5",
  green: "#39745C",
  greenWash: "#EDF5F0",
  red: "#A44848",
  redWash: "#FAEEEE",
  subtle: "#F1F1EF",
  shadow: "#000000",
} as const;

/** 深色模式色彩方案 */
export const darkColors: ThemeColors = {
  canvas: "#101318",
  paper: "#171B21",
  ink: "#F2F4F7",
  muted: "#A3AAB5",
  rule: "#292F38",
  navy: "#F2F4F7",
  primary: "#6F98F5",
  // 深色下主按钮「浅蓝底 + 深字」：primary #6F98F5 vs #101318 = 6.98:1（WCAG AA）
  // light 模式保持白字（primary #315B8F vs #FFFFFF = 6.95:1）
  onPrimary: "#101318",
  blue: "#6F98F5",
  blueWash: "#202B43",
  orange: "#E9A24C",
  orangeWash: "#31271A",
  green: "#55B58D",
  greenWash: "#182D25",
  red: "#F06B6B",
  redWash: "#352022",
  subtle: "#1D222A",
  shadow: "#000000",
};

/** 主题色彩类型，确保浅色和深色方案拥有相同的语义键 */
export type ThemeColors = { [Key in keyof typeof lightColors]: string };

// Transitional light palette for modules that do not render UI directly.
export const colors = lightColors;
