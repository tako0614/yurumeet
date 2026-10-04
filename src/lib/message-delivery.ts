import { ApiError } from "@takosjp/yurucommu-api";

export type MessageDeliveryFailure = "rejected" | "unconfirmed";

/** A key-less expiry response rejects the whole submitted attachment set. */
export function isExpiredMessageMedia(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === "MEDIA_EXPIRED"
  );
}

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
