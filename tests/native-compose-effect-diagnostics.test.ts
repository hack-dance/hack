import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorResultFromUnknown } from "../src/lib/cli-result.ts";
import {
  assertNativeComposeEffectOwned,
  tryNativeComposeCommand,
} from "../src/lib/native-compose-command.ts";
import {
  attachNativeComposeEffectRefusal,
  copyNativeComposeEffectRefusal,
  nativeComposeEffectReason,
  nativeComposeEffectRefusal,
  retainNativeComposeEffectRefusal,
} from "../src/lib/native-compose-effect-diagnostics.ts";
import * as generation from "../src/lib/native-compose-generation.ts";
import {
  createNativeComposeProbe,
  NativeComposeOwnershipError,
} from "../src/lib/native-compose-ownership.ts";
import { restoreEnv } from "./helpers/env.ts";

const DIAGNOSTIC = {
  stage: "effect-witness",
  reason: "private-state",
} as const;

test("effect diagnostics snapshot closed data and keep the first issued boundary", () => {
  const error = new Error("private-source-resource-canary");
  const detail = { stage: "effect-witness", reason: "private-state" };
  attachNativeComposeEffectRefusal(error, detail);
  detail.reason = "private-mutated-canary";
  attachNativeComposeEffectRefusal(error, {
    stage: "effect-finalization",
    reason: "private-uncertain",
  });
  expect(nativeComposeEffectRefusal(error)).toEqual(DIAGNOSTIC);
  expect(Object.isFrozen(nativeComposeEffectRefusal(error))).toBe(true);
  expect(JSON.stringify(nativeComposeEffectRefusal(error))).not.toContain(
    "canary"
  );
});

test("effect diagnostic issuance refuses accessors and unknown data without reading getters", () => {
  let reads = 0;
  const getter = Object.defineProperty({ reason: "private-state" }, "stage", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("private-getter-canary");
    },
  });
  for (const detail of [
    getter,
    Object.create(DIAGNOSTIC),
    { ...DIAGNOSTIC, reason: "private-unknown-canary" },
    { ...DIAGNOSTIC, stage: "private-path-canary" },
    { ...DIAGNOSTIC, secret: "private-value-canary" },
    { ...DIAGNOSTIC, [Symbol("private-symbol-canary")]: true },
  ]) {
    const error = new Error("fixed");
    expect(() => attachNativeComposeEffectRefusal(error, detail)).toThrow(
      "values omitted"
    );
    expect(nativeComposeEffectRefusal(error)).toBeUndefined();
  }
  expect(reads).toBe(0);
});

test("copied public detail, prototypes, raw codes and getters cannot forge issued diagnostics", () => {
  const error = new Error("private-original-canary");
  attachNativeComposeEffectRefusal(error, DIAGNOSTIC);
  let reads = 0;
  const getter = Object.defineProperty({}, "detail", {
    get: () => {
      reads += 1;
      throw new Error("private-getter-canary");
    },
  });
  for (const forged of [
    null,
    "private-primitive-canary",
    { ...error },
    Object.create(error),
    { code: "E_NATIVE_COMPOSE_STATE", detail: DIAGNOSTIC },
    getter,
  ]) {
    expect(nativeComposeEffectRefusal(forged)).toBeUndefined();
  }
  expect(reads).toBe(0);
});

test("reason classification reads only closed own data on the known error classes", () => {
  for (const [code, reason] of [
    ["E_NATIVE_COMPOSE_STATE", "private-state"],
    ["E_NATIVE_COMPOSE_BUSY", "private-busy"],
    ["E_NATIVE_COMPOSE_STALE", "private-stale"],
    ["E_NATIVE_COMPOSE_UNCERTAIN", "private-uncertain"],
  ] as const) {
    expect(
      nativeComposeEffectReason(
        new generation.NativeComposeGenerationError(code)
      )
    ).toBe(reason);
  }
  for (const [code, reason] of [
    ["E_NATIVE_COMPOSE_OWNERSHIP", "resource-ownership"],
    ["E_NATIVE_COMPOSE_NETWORK_TRANSITION", "network-transition"],
    ["E_NATIVE_COMPOSE_PROBE_TIMEOUT", "probe-timeout"],
    ["E_NATIVE_COMPOSE_PROBE_CANCELLED", "probe-cancel"],
    ["E_NATIVE_COMPOSE_PROBE_BUDGET", "probe-budget"],
    ["E_NATIVE_COMPOSE_PROBE", "probe-unclassified"],
  ] as const) {
    expect(
      nativeComposeEffectReason(new NativeComposeOwnershipError(code))
    ).toBe(reason);
  }
  let reads = 0;
  const getter = new generation.NativeComposeGenerationError(
    "E_NATIVE_COMPOSE_STATE"
  );
  Object.defineProperty(getter, "code", {
    get: () => {
      reads += 1;
      throw new Error("private-code-canary");
    },
  });
  expect(nativeComposeEffectReason(getter)).toBe("unclassified");
  expect(nativeComposeEffectReason({ code: "E_NATIVE_COMPOSE_STATE" })).toBe(
    "unclassified"
  );
  expect(reads).toBe(0);
});

test("optional issuance and translation preserve primitive/proxy failure precedence", () => {
  const primitive = "private-primitive-canary";
  expect(() =>
    retainNativeComposeEffectRefusal(primitive, DIAGNOSTIC)
  ).not.toThrow();
  const proxy = new Proxy(DIAGNOSTIC, {
    ownKeys: () => {
      throw new Error("private-proxy-canary");
    },
  });
  expect(() =>
    retainNativeComposeEffectRefusal(new Error("fixed"), proxy)
  ).not.toThrow();
  const target = new Error("fixed translation");
  copyNativeComposeEffectRefusal({ detail: DIAGNOSTIC }, target);
  expect(nativeComposeEffectRefusal(target)).toBeUndefined();
  const source = new Error("private-source-canary");
  attachNativeComposeEffectRefusal(source, DIAGNOSTIC);
  copyNativeComposeEffectRefusal(source, target);
  expect(nativeComposeEffectRefusal(target)).toEqual(DIAGNOSTIC);
});

test.each([
  "issued",
  "forged",
] as const)("public native command exposes only %s diagnostic provenance and unchanged fixed code/text", async (kind) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-effect-diagnostic-"))
  );
  const oldBackend = process.env.HACK_RUNTIME_BACKEND;
  const error = new generation.NativeComposeGenerationError(
    "E_NATIVE_COMPOSE_UNCERTAIN"
  );
  if (kind === "issued") {
    attachNativeComposeEffectRefusal(error, DIAGNOSTIC);
  } else {
    Object.assign(error, {
      detail: { native_compose_effect_refusal: DIAGNOSTIC },
      cause: "private-canary",
    });
  }
  const opened = spyOn(
    generation,
    "openNativeComposeGenerationStore"
  ).mockImplementation(() => Promise.reject(error));
  try {
    process.env.HACK_RUNTIME_BACKEND = "compose";
    await mkdir(join(root, ".hack"));
    await Bun.write(
      join(root, ".hack/hack.project.json"),
      JSON.stringify({ schema_version: 1, name: "fixture" })
    );
    let caught: unknown;
    try {
      await tryNativeComposeCommand({
        cwd: root,
        operation: "down",
        json: true,
      });
    } catch (value) {
      caught = value;
    }
    expect(opened).toHaveBeenCalledTimes(1);
    expect(errorResultFromUnknown({ error: caught })).toEqual({
      ok: false,
      error: {
        code: "E_CONFIG_INVALID",
        message: error.message,
        ...(kind === "issued"
          ? { detail: { native_compose_effect_refusal: DIAGNOSTIC } }
          : {}),
      },
    });
  } finally {
    opened.mockRestore();
    restoreEnv("HACK_RUNTIME_BACKEND", oldBackend);
    await rm(root, { recursive: true, force: true });
  }
});

test("reason classification preserves an original issued probe refusal without creating a child", () => {
  let caught: unknown;
  try {
    createNativeComposeProbe({ timeoutMs: 0 });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NativeComposeOwnershipError);
  expect(nativeComposeEffectReason(caught)).toBe("probe-operation");
  if (!(caught instanceof NativeComposeOwnershipError)) {
    throw new Error("Expected original owned probe refusal");
  }
  const copied = { ...caught };
  expect(nativeComposeEffectReason(copied)).toBe("unclassified");
});

test.each([
  "guard-fresh-before",
  "guard-ownership",
  "guard-storage",
  "guard-fresh-after",
] as const)("effect guard records original %s failure at its existing boundary", async (selected) => {
  const order: string[] = [];
  const original = new generation.NativeComposeGenerationError(
    "E_NATIVE_COMPOSE_STATE"
  );
  let fresh = 0;
  const boundary = (stage: string) => {
    order.push(stage);
    if (stage === selected) {
      throw original;
    }
  };
  let caught: unknown;
  try {
    await assertNativeComposeEffectOwned({
      assertFresh: async () => {
        fresh += 1;
        boundary(fresh === 1 ? "guard-fresh-before" : "guard-fresh-after");
      },
      assertOwned: async () => {
        boundary("guard-ownership");
      },
      verifyStorage: async () => {
        boundary("guard-storage");
      },
    });
  } catch (error) {
    caught = error;
  }
  const stages = [
    "guard-fresh-before",
    "guard-ownership",
    "guard-storage",
    "guard-fresh-after",
  ];
  expect(order).toEqual(stages.slice(0, stages.indexOf(selected) + 1));
  expect(caught).toBe(original);
  expect(nativeComposeEffectRefusal(caught)).toEqual({
    stage: selected,
    reason: "private-state",
  });
});
