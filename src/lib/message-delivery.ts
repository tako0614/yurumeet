import { ApiError } from "@takosjp/yurucommu-api";

export type MessageDeliveryFailure = "rejected" | "unconfirmed";

/** Classify only explicit client HTTP errors as a confirmed rejection. */
export function classifyMessageDeliveryFailure(
  error: unknown,
): MessageDeliveryFailure {
  if (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  ) {
    return "rejected";
  }
  return "unconfirmed";
}
