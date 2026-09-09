/**
 * 共享确认弹窗控制器（promise 化，替换原生 window.confirm）
 * 在 OperationsShell 挂载一次 <WfConfirmDialog /> 即可全局使用。
 */
import { reactive } from "vue";

export type ConfirmDialogState = {
  open: boolean;
  message: string;
  danger: boolean;
  resolve: ((value: boolean) => void) | null;
};

export const confirmDialogState = reactive<ConfirmDialogState>({
  open: false,
  message: "",
  danger: false,
  resolve: null,
});

/** 弹确认框；确认返回 true，取消返回 false */
export function confirmDialog(
  message: string,
  options: { danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmDialogState.message = message;
    confirmDialogState.danger = Boolean(options.danger);
    confirmDialogState.resolve = resolve;
    confirmDialogState.open = true;
  });
}

