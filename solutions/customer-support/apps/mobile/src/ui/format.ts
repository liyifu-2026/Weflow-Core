/**
 * 时间展示工具
 * 与会话详情页的本地实现保持一致：本地时间 HH:mm（24 小时制），非法时间显示"记录"。
 */
export function formatTime(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? "记录"
    : time.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}

/** 按本地时区格式化日期（如 8月12日） */
export function formatDay(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "记录";
  return time.toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}
