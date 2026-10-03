import { expect, test } from "bun:test";
import { ApiError } from "@takosjp/yurucommu-api";
import { classifyMessageDeliveryFailure } from "./message-delivery.ts";

test("transport, abort, response parse, and server failures are unconfirmed", () => {
  expect(classifyMessageDeliveryFailure(new TypeError("network failed"))).toBe(
    "unconfirmed",
  );
  expect(
    classifyMessageDeliveryFailure(new DOMException("aborted", "AbortError")),
  ).toBe("unconfirmed");
  expect(
    classifyMessageDeliveryFailure(new SyntaxError("invalid JSON response")),
  ).toBe("unconfirmed");
  expect(
    classifyMessageDeliveryFailure(new ApiError(500, "server error")),
  ).toBe("unconfirmed");
});

test("408 and non-SDK lookalikes remain unconfirmed", () => {
  expect(
    classifyMessageDeliveryFailure(new ApiError(408, "request timeout")),
  ).toBe("unconfirmed");
  expect(
    classifyMessageDeliveryFailure({
      name: "ApiError",
      status: 422,
      message: "foreign lookalike",
    }),
  ).toBe("unconfirmed");
  expect(
    classifyMessageDeliveryFailure(
      Object.assign(new Error("foreign lookalike"), { status: 422 }),
    ),
  ).toBe("unconfirmed");
});

test("received non-timeout 4xx SDK responses are rejected", () => {
  for (const status of [400, 401, 404, 422]) {
    expect(
      classifyMessageDeliveryFailure(new ApiError(status, "request rejected")),
    ).toBe("rejected");
  }
});
