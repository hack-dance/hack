import { expect, test } from "bun:test";
import { CommandError } from "../src/lib/shell.ts";
import { upgradeCheckFailureClass } from "../src/lib/upgrade-check-failure.ts";

test("upgrade diagnostics classify failures without exposing messages, output or arbitrary error names", () => {
  const sentinel = "fixture-value-must-stay-private";
  const cases: [unknown, string][] = [
    [new TypeError(sentinel), "type-error"],
    [new SyntaxError(sentinel), "parse-error"],
    [new RangeError(sentinel), "range-error"],
    [
      Object.assign(new Error(sentinel), { code: "EACCES" }),
      "permission-denied",
    ],
    [Object.assign(new Error(sentinel), { code: "ENOENT" }), "missing-path"],
    [
      Object.assign(new Error(sentinel), { code: sentinel, name: sentinel }),
      "unexpected-error",
    ],
    [
      new CommandError({
        cmd: [sentinel],
        exitCode: 1,
        stdout: sentinel,
        stderr: sentinel,
      }),
      "command-error",
    ],
    [sentinel, "unexpected-error"],
  ];
  for (const [error, expected] of cases) {
    expect(upgradeCheckFailureClass(error)).toBe(expected);
    expect(upgradeCheckFailureClass(error)).not.toContain(sentinel);
  }
});
