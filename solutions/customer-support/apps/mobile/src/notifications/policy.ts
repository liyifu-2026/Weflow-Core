/**
 * 通知隐私策略模块
 * 定义通知消息预览的默认策略：新设备默认隐藏消息正文，保护客户隐私。
 */
export type ConfirmedPreviewPreference = {
  showPreview: boolean;
  confirmedAt: string;
};

/** 获取设备注册时的预览偏好：有确认记录则沿用，否则默认隐藏 */
export function registrationPreviewPreference(
  confirmed: ConfirmedPreviewPreference | undefined,
): boolean {
  return confirmed?.showPreview ?? false;
}
