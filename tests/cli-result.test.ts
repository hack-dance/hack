import { expect, test } from "bun:test";

import {
  errorResult,
  errorResultFromUnknown,
  exitCodeForResult,
  HackCliError,
  okResult,
  renderCliResult,
} from "../src/lib/cli-result.ts";

test("okResult wraps data in the success envelope", () => {
  const result = okResult({ data: { services: ["api"] } });
  expect(result).toEqual({ ok: true, data: { services: ["api"] } });
});

test("errorResult carries code, message, and optional detail", () => {
  const bare = errorResult({
    code: "E_DOCKER_UNAVAILABLE",
    message: "docker missing",
  });
  expect(bare).toEqual({
    ok: false,
    error: { code: "E_DOCKER_UNAVAILABLE", message: "docker missing" },
  });
  expect("detail" in bare.error).toBe(false);

  const detailed = errorResult({
    code: "E_COMPOSE_FAILED",
    message: "compose up failed",
    detail: { exitCode: 17 },
  });
  expect(detailed.error.detail).toEqual({ exitCode: 17 });
});

test("exitCodeForResult keeps 0/1 semantics", () => {
  expect(exitCodeForResult({ result: okResult({ data: null }) })).toBe(0);
  expect(
    exitCodeForResult({
      result: errorResult({ code: "E_UNEXPECTED", message: "boom" }),
    })
  ).toBe(1);
});

test("renderCliResult produces parseable pretty JSON with trailing newline", () => {
  const text = renderCliResult({
    result: okResult({ data: { branch: "feat-x" } }),
  });
  expect(text.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(text) as { ok: boolean; data: { branch: string } };
  expect(parsed.ok).toBe(true);
  expect(parsed.data.branch).toBe("feat-x");
});

test("errorResultFromUnknown preserves HackCliError codes", () => {
  const err = new HackCliError({
    code: "E_INTERACTIVE_REQUIRED",
    message: "needs a TTY",
    detail: { flag: "--no-interactive" },
  });
  const result = errorResultFromUnknown({ error: err });
  expect(result.error.code).toBe("E_INTERACTIVE_REQUIRED");
  expect(result.error.message).toBe("needs a TTY");
  expect(result.error.detail).toEqual({ flag: "--no-interactive" });
});

test("errorResultFromUnknown maps plain errors to E_UNEXPECTED", () => {
  const result = errorResultFromUnknown({ error: new Error("kaboom") });
  expect(result.error.code).toBe("E_UNEXPECTED");
  expect(result.error.message).toBe("kaboom");
});

test("errorResultFromUnknown honors a fallback code for plain errors", () => {
  const result = errorResultFromUnknown({
    error: new Error("no compose"),
    fallbackCode: "E_COMPOSE_FAILED",
  });
  expect(result.error.code).toBe("E_COMPOSE_FAILED");
});
