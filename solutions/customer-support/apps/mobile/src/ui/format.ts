/**
 * 时间展示工具
 * 时间统一走本地时区：HH:mm（24 小时制），非法时间显示"记录"。
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

/** 两个时间串是否为同一自然日（本地时区） */
export function isSameDay(first: string, second: string): boolean {
  const firstDate = new Date(first);
  const secondDate = new Date(second);
  return (
    firstDate.getFullYear() === secondDate.getFullYear() &&
    firstDate.getMonth() === secondDate.getMonth() &&
    firstDate.getDate() === secondDate.getDate()
  );
}

/** 会话日期分组标题：今天 / 8月12日；非法时间显示"会话记录" */
export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "会话记录";
  const now = new Date();
  if (isSameDay(now.toISOString(), value)) return "今天";
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}
