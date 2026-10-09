import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorResultFromUnknown } from "../src/lib/cli-result.ts";
import { tryNativeComposeCommand } from "../src/lib/native-compose-command.ts";
import {
  attachNativeComposeEffectRefusal,
  copyNativeComposeEffectRefusal,
  nativeComposeEffectReason,
  nativeComposeEffectRefusal,
} from "../src/lib/native-compose-effect-diagnostics.ts";
import * as generation from "../src/lib/native-compose-generation.ts";

const diagnostic = {
  stage: "vm-retirement-volume-policy",
  reason: "private-state",
} as const;

test("VM diagnostics retain only the first closed issued boundary", () => {
  const original = new generation.NativeComposeGenerationError(
    "E_NATIVE_COMPOSE_STATE"
  );
  attachNativeComposeEffectRefusal(original, diagnostic);
  attachNativeComposeEffectRefusal(original, {
    stage: "vm-retirement-volume-removal",
    reason: "unclassified",
  });
  const normalized = new generation.NativeComposeGenerationError(
    "E_NATIVE_COMPOSE_UNCERTAIN"
  );
  copyNativeComposeEffectRefusal(original, normalized);
  expect(nativeComposeEffectRefusal(normalized)).toEqual(diagnostic);
  expect(Object.isFrozen(nativeComposeEffectRefusal(normalized))).toBe(true);
  expect(nativeComposeEffectReason({ code: "E_NATIVE_COMPOSE_STATE" })).toBe(
    "unclassified"
  );
  let reads = 0;
  const getter = Object.defineProperty({ reason: "private-state" }, "stage", {
    get() {
      reads++;
      return "vm-retirement-volume-policy";
    },
  });
  for (const value of [
    getter,
    { ...diagnostic, stage: "private-path-canary" },
    { ...diagnostic, reason: "private-value-canary" },
    { ...diagnostic, extra: "private-source-canary" },
  ]) {
    const error = new Error("private-original-canary");
    expect(() => attachNativeComposeEffectRefusal(error, value)).toThrow(
      "values omitted"
    );
    expect(nativeComposeEffectRefusal(error)).toBeUndefined();
  }
  expect(reads).toBe(0);
  expect(
    nativeComposeEffectRefusal({ ...normalized, detail: diagnostic })
  ).toBeUndefined();
});

test.each([
  "issued",
  "forged",
] as const)("public VM refusal includes only %s diagnostic provenance", async (kind) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-vm-diagnostic-"))
  );
  const backend = process.env.HACK_RUNTIME_BACKEND;
  const error = new generation.NativeComposeGenerationError(
    "E_NATIVE_COMPOSE_UNCERTAIN"
  );
  if (kind === "issued") {
    attachNativeComposeEffectRefusal(error, diagnostic);
  } else {
    Object.assign(error, {
      detail: { native_compose_effect_refusal: diagnostic },
    });
  }
  const opened = spyOn(
    generation,
    "openNativeComposeGenerationStore"
  ).mockRejectedValue(error);
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
          ? { detail: { native_compose_effect_refusal: diagnostic } }
          : {}),
      },
    });
  } finally {
    opened.mockRestore();
    if (backend === undefined) {
      Reflect.deleteProperty(process.env, "HACK_RUNTIME_BACKEND");
    } else {
      process.env.HACK_RUNTIME_BACKEND = backend;
    }
    await rm(root, { recursive: true, force: true });
  }
});
