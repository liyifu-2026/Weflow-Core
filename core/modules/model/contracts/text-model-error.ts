export type TextModelErrorCode =
  | "configuration"
  | "authentication"
  | "unavailable"
  | "timeout"
  | "rate_limited"
  | "invalid_request"
  | "invalid_response"
  | "structured_output_unsupported"
  | "content_rejected"
  | "cancelled"
  | "unknown";

export class TextModelError extends Error {
  override readonly name = "TextModelError";

  constructor(
    readonly code: TextModelErrorCode,
    message: string,
    readonly options: {
      retryable?: boolean;
      cause?: unknown;
      reason?: string;
    } = {},
  ) {
    super(message, { cause: options.cause });
  }
}
