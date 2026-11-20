import { expect, test } from "bun:test";
import { runNativeRecover } from "../src/commands/native.ts";

const runtime = { binary: "/fixture/hack-native", home: "/fixture/home" };

test("hack native recover runs the runtime's recovery and says what it left", async () => {
  const requests: unknown[] = [];
  let out = "";
  const code = await runNativeRecover({
    runtime,
    cwd: "/fixture/project",
    json: false,
    invoke: async (request) => {
      requests.push(request.args);
      return { phase: "recovered-unclean", process_alive: false };
    },
    write: (text) => {
      out += text;
    },
  });
  expect(code).toBe(0);
  expect(requests).toEqual([["runtime", "recover", "--json"]]);
  expect(out).toBe(
    "Native runtime recovered; its state is now recovered-unclean. Run hack up to start again.\n"
  );
});

test("hack native recover passes JSON through and reports an empty home", async () => {
  let out = "";
  const result = { phase: "uninitialized" };
  await runNativeRecover({
    runtime,
    cwd: "/fixture",
    json: true,
    invoke: async () => result,
    write: (text) => {
      out += text;
    },
  });
  expect(JSON.parse(out)).toEqual(result);
  out = "";
  await runNativeRecover({
    runtime,
    cwd: "/fixture",
    json: false,
    invoke: async () => result,
    write: (text) => {
      out += text;
    },
  });
  expect(out).toBe("Native runtime has nothing to recover in this home.\n");
});

test("hack native recover propagates a runtime refusal unchanged", async () => {
  const refusal = new Error("recovery_required");
  await expect(
    runNativeRecover({
      runtime,
      cwd: "/fixture",
      json: false,
      invoke: async () => {
        throw refusal;
      },
      write: () => undefined,
    })
  ).rejects.toBe(refusal);
});
