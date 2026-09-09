/**
 * 登录页大气层（spatial composition，非插画）
 *
 * 独立 SVG 几何：左上露出一角的极淡蓝大椭圆、极细曲线、2–3 个小几何与局部点阵。
 * 右侧（表单区）保持干净。react-native-svg 不支持 feGaussianBlur，
 * 因此用低透明度渐变模拟柔光，不使用 filter。
 * 深色模式换用深蓝黑画布上的冷蓝几何（更低透明度），不做简单反色。
 */
import { useEffect, useState } from "react";
import { Animated, StyleSheet } from "react-native";
import Svg, { Circle, Ellipse, G, Line, Path, Rect } from "react-native-svg";
import { useReducedMotion } from "./use-reduced-motion";

const LIGHT = (
  <>
    <Ellipse cx={120} cy={-180} rx={560} ry={560} fill="#DCEBFA" opacity={0.55} />
    <Circle cx={620} cy={300} r={300} fill="#E8F2FB" opacity={0.42} />
    <Path
      d="M-40 700C260 520 520 560 780 420C980 310 1120 260 1280 180"
      stroke="#C9E0F5"
      strokeWidth={1.5}
      opacity={0.6}
      fill="none"
    />
    <Path
      d="M-40 780C300 640 600 660 900 520"
      stroke="#D8E6F3"
      strokeWidth={1}
      opacity={0.5}
      fill="none"
    />
    <Circle cx={150} cy={560} r={26} stroke="#B9D8F2" strokeWidth={1.5} opacity={0.7} fill="none" />
    <Rect x={250} y={330} width={14} height={14} fill="#C9E0F5" opacity={0.55} />
    <Line x1={330} y1={620} x2={382} y2={620} stroke="#B9D8F2" strokeWidth={2} opacity={0.55} />
    <Path
      d="M1180 140C1260 200 1300 300 1280 420"
      stroke="#D8E6F3"
      strokeWidth={1}
      opacity={0.35}
      fill="none"
    />
    <G fill="#B9D8F2" opacity={0.4}>
      {[0, 28, 56, 84].flatMap((dx) =>
        [0, 28, 56].map((dy) => (
          <Circle key={`${dx}-${dy}`} cx={80 + dx} cy={180 + dy} r={3} />
        )),
      )}
    </G>
  </>
);

const DARK = (
  <>
    <Ellipse cx={120} cy={-180} rx={560} ry={560} fill="#1E3A5F" opacity={0.5} />
    <Circle cx={620} cy={300} r={300} fill="#274B75" opacity={0.32} />
    <Path
      d="M-40 700C260 520 520 560 780 420C980 310 1120 260 1280 180"
      stroke="#2A4A75"
      strokeWidth={1.5}
      opacity={0.45}
      fill="none"
    />
    <Path
      d="M-40 780C300 640 600 660 900 520"
      stroke="#27406B"
      strokeWidth={1}
      opacity={0.35}
      fill="none"
    />
    <Circle cx={150} cy={560} r={26} stroke="#2A4A75" strokeWidth={1.5} opacity={0.55} fill="none" />
    <Rect x={250} y={330} width={14} height={14} fill="#2A4A75" opacity={0.4} />
    <Line x1={330} y1={620} x2={382} y2={620} stroke="#2A4A75" strokeWidth={2} opacity={0.4} />
    <Path
      d="M1180 140C1260 200 1300 300 1280 420"
      stroke="#2A4A75"
      strokeWidth={1}
      opacity={0.25}
      fill="none"
    />
    <G fill="#2A4A75" opacity={0.3}>
      {[0, 28, 56, 84].flatMap((dx) =>
        [0, 28, 56].map((dy) => (
          <Circle key={`${dx}-${dy}`} cx={80 + dx} cy={180 + dy} r={3} />
        )),
      )}
    </G>
  </>
);

/** 登录页空间大气层：极轻 opacity reveal（Motion=2，仅一次，不循环） */
export function LoginAtmosphere({ variant }: { variant: "light" | "dark" }) {
  const reducedMotion = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: reducedMotion ? 0 : 320,
      useNativeDriver: true,
    }).start();
  }, [opacity, reducedMotion]);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { opacity }]}
    >
      <Svg width="100%" height="100%" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        {variant === "dark" ? DARK : LIGHT}
      </Svg>
    </Animated.View>
  );
}
