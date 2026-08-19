import type { ErrorCode } from "./errors.js";

export interface ApiError {
  code: ErrorCode;
  message: string;
  requestId: string;
  details?: unknown;
}

export type ApiEnvelope<T> =
  | {
      data: T;
    }
  | {
      error: ApiError;
    };
