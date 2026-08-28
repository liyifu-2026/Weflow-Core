/**
 * 减弱动画偏好检测 Hook
 * 检测系统是否开启了减弱动画设置，用于在动画组件中适配无障碍需求。
 */
import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** 获取系统减弱动画设置状态 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReducedMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reducedMotion;
}
