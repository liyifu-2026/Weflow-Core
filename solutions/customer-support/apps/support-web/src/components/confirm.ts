import { reactive } from "vue";

export type SupportConfirmState = {
  open: boolean;
  message: string;
  danger: boolean;
  resolve: ((value: boolean) => void) | null;
};

export const supportConfirmState = reactive<SupportConfirmState>({
  open: false,
  message: "",
  danger: false,
  resolve: null,
});

export function supportConfirm(
  message: string,
  options: { danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    supportConfirmState.message = message;
    supportConfirmState.danger = Boolean(options.danger);
    supportConfirmState.resolve = resolve;
    supportConfirmState.open = true;
  });
}
