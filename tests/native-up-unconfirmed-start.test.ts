import { expect, test } from "bun:test";
import { explainUnconfirmedNativeDetachedStart } from "../src/commands/native-up-already-running.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

const scope = {
  projectRoot: "/work/app",
  projectDir: "/work/app/.hack",
  nativeHome: "/native/new-home",
  branch: null,
};
const unconfirmed = new HackCliError({
  code: "E_STARTUP_INCOMPLETE",
  message: "Native detached startup was not confirmed.",
});
const foreign = new HackCliError({
  code: "E_NATIVE_RUN_MAPPING_FOREIGN_HOME",
  message: "Native project run mapping belongs to another native home.",
});

test("a foreign-home mapping published after the probe replaces the generic unconfirmed start (HACK-2339)", async () => {
  const inspected: unknown[] = [];
  expect(
    await explainUnconfirmedNativeDetachedStart({
      error: unconfirmed,
      scope,
      inspect: (selected) => {
        inspected.push(selected);
        return Promise.resolve(foreign);
      },
    })
  ).toBe(foreign);
  expect(inspected).toEqual([scope]);
});

test("without a foreign-home mapping, or when inspection fails, the original error stays", async () => {
  expect(
    await explainUnconfirmedNativeDetachedStart({
      error: unconfirmed,
      scope,
      inspect: () => Promise.resolve(undefined),
    })
  ).toBe(unconfirmed);
  expect(
    await explainUnconfirmedNativeDetachedStart({
      error: unconfirmed,
      scope,
      inspect: () => Promise.reject(new Error("unreadable")),
    })
  ).toBe(unconfirmed);
});

test("only an unconfirmed start is re-inspected", async () => {
  const other = new HackCliError({ code: "E_CANCELLED", message: "canceled" });
  let calls = 0;
  const inspect = () => {
    calls++;
    return Promise.resolve(foreign);
  };
  expect(
    await explainUnconfirmedNativeDetachedStart({
      error: other,
      scope,
      inspect,
    })
  ).toBe(other);
  expect(
    await explainUnconfirmedNativeDetachedStart({
      error: unconfirmed,
      scope: null,
      inspect,
    })
  ).toBe(unconfirmed);
  expect(calls).toBe(0);
});
