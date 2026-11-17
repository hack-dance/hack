import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NativeComposeHook,
  selectNativeComposeAfterHooks,
  selectNativeComposeBeforeHooks,
  selectNativeComposeDownHooks,
} from "../src/lib/native-compose-host-contract.ts";
import {
  assertNativeComposeBeforeHookBindings,
  runNativeComposeBeforeHooks,
} from "../src/lib/native-compose-host-hooks.ts";
import type { NativeEnvironmentPlan } from "../src/lib/native-env-plan-protocol.ts";
import { NativeEnvironmentNameError } from "../src/lib/native-environment-name-error.ts";
import { restoreEnv } from "./helpers/env.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-compose-host-hooks-"))
  );
  roots.push(root);
  return root;
}
function hook(
  name: string,
  command: NativeComposeHook["command"]
): NativeComposeHook {
  return { name, command, env_target: { kind: "host" } };
}
function environment(
  hooks: readonly NativeComposeHook[]
): NativeEnvironmentPlan {
  return {
    plan_version: 1,
    overlay: null,
    overlay_exists: true,
    complete: true,
    workloads: {},
    warnings: [],
    diagnostics: [],
    host: Object.fromEntries(
      hooks.map((entry) => [
        entry.name,
        { env_target: entry.env_target ?? { kind: "host" }, bindings: {} },
      ])
    ),
  };
}
async function execute(
  root: string,
  hooks: readonly NativeComposeHook[],
  timeoutMs = 5000
) {
  return await runNativeComposeBeforeHooks({
    hooks,
    projectRoot: root,
    environmentPlan: environment(hooks),
    resolveHostValues: () => Promise.resolve({}),
    signal: new AbortController().signal,
    timeoutMs,
    json: true,
  });
}

test("finite up.before preserves authored order, exec argv, shell expansion and checkout cwd", async () => {
  const root = await fixture();
  const hooks = [
    hook("one", {
      exec: [
        process.execPath,
        "-e",
        'await Bun.write("first", JSON.stringify({args: process.argv.slice(1),cwd: process.cwd()}))',
        "literal $VALUE",
        "",
      ],
    }),
    hook("two", {
      shell: 'test -f first && printf "%s" "shell $VALUE" > second',
    }),
  ];
  hooks[1] = {
    ...hook("two", {
      shell: 'test -f first && printf "%s" "shell $VALUE" > second',
    }),
    environment: { VALUE: { literal: "expanded" } },
  };
  const base = environment(hooks);
  const plan = {
    ...base,
    host: {
      ...base.host,
      two: {
        env_target: { kind: "host" } as const,
        bindings: { VALUE: { kind: "literal", value: "expanded" } as const },
      },
    },
  };
  const result = await runNativeComposeBeforeHooks({
    hooks,
    projectRoot: root,
    environmentPlan: plan,
    resolveHostValues: () => Promise.resolve({}),
    signal: new AbortController().signal,
    timeoutMs: 5000,
    json: true,
  });
  expect(result).toEqual({ outcome: "complete", value: 0 });
  const first = JSON.parse(await readFile(join(root, "first"), "utf8"));
  expect(first.args).toEqual(["literal $VALUE", ""]);
  expect(first.cwd).toBe(root);
  expect(await readFile(join(root, "second"), "utf8")).toBe("shell expanded");
});

test("nonzero hook stops the sequence and preserves its exit status", async () => {
  const root = await fixture();
  expect(
    await execute(root, [
      hook("fail", { exec: [process.execPath, "-e", "process.exit(17)"] }),
      hook("later", { shell: "touch later" }),
    ])
  ).toEqual({ outcome: "complete", value: 17 });
  expect(await Bun.file(join(root, "later")).exists()).toBe(false);
});

test("selected host baselines, remapped refs, explicit empty and unset stay isolated", async () => {
  const root = await fixture();
  const original = process.env.AMBIENT;
  process.env.AMBIENT = "must-be-unset";
  try {
    const selected = {
      ...hook("selected", {
        exec: [
          process.execPath,
          "-e",
          'await Bun.write("values",JSON.stringify([process.env.TOKEN,process.env.REMAPPED,process.env.EMPTY,process.env.AMBIENT,process.env.GUEST]))',
        ],
      }),
      env_target: { kind: "workload", name: "web" } as const,
      environment: {
        TOKEN: { literal: "override" },
        REMAPPED: { env_ref: "TOKEN" },
        EMPTY: { default: "" },
        AMBIENT: { unset: true },
      },
    };
    const base = environment([selected]);
    const plan: NativeEnvironmentPlan = {
      ...base,
      host: {
        selected: {
          env_target: selected.env_target,
          bindings: {
            TOKEN: { kind: "literal", value: "override" },
            REMAPPED: {
              kind: "managed",
              key: "TOKEN",
              scope: "web",
              secret: true,
            },
            EMPTY: { kind: "default", value: "" },
          },
        },
      },
    };
    const result = await runNativeComposeBeforeHooks({
      hooks: [selected],
      projectRoot: root,
      environmentPlan: plan,
      resolveHostValues: () =>
        Promise.resolve({ TOKEN: "private-selected-canary" }),
      signal: new AbortController().signal,
      timeoutMs: 5000,
      json: true,
    });
    expect(result).toEqual({ outcome: "complete", value: 0 });
    expect(JSON.parse(await readFile(join(root, "values"), "utf8"))).toEqual([
      "override",
      "private-selected-canary",
      "",
      null,
      null,
    ]);
  } finally {
    restoreEnv("AMBIENT", original);
  }
});

test("timeout reaps a resistant descendant group and blocks later hooks", async () => {
  const root = await fixture();
  // Arm TERM resistance before publishing the exact descendant PID. Keep all
  // startup inside the original 100 ms budget, without cold Bun startup.
  const program = `/bin/sh -c 'trap "" TERM; printf "%s" "$$" > pid; exec /bin/sleep 60' & wait`;
  const result = await execute(
    root,
    [
      hook("timeout", { exec: ["/bin/sh", "-c", program] }),
      hook("later", { shell: "touch later" }),
    ],
    100
  );
  expect(result).toEqual({ outcome: "complete", value: 124 });
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await Bun.file(join(root, "later")).exists()).toBe(false);
});

test("all finite lifecycle phases select while persistent processes, traversal and unknown fields refuse", () => {
  const valid = hook("before", { shell: "true" });
  for (const host of [
    { processes: { worker: valid } },
    { up: { before: [{ ...valid, cwd: "../outside" }] } },
    { up: { before: [{ ...valid, persistent: true }] } },
  ]) {
    expect(() => selectNativeComposeBeforeHooks({ host })).toThrow(
      "finite lifecycle"
    );
  }
  expect(
    selectNativeComposeBeforeHooks({ host: { up: { before: [valid] } } })
  ).toEqual([valid]);
  const after = hook("after", { shell: "true" });
  const both = { host: { up: { before: [valid], after: [after] } } };
  expect(selectNativeComposeBeforeHooks(both)).toEqual([valid]);
  expect(selectNativeComposeAfterHooks(both)).toEqual([after]);
  const downBefore = hook("down-before", { shell: "true" });
  const downAfter = hook("down-after", { shell: "true" });
  expect(
    selectNativeComposeDownHooks({
      host: {
        ...both.host,
        down: { before: [downBefore], after: [downAfter] },
      },
    })
  ).toEqual({ before: [downBefore], after: [downAfter] });
  expect(() =>
    selectNativeComposeDownHooks({
      host: { up: { before: [valid] }, down: { after: [valid] } },
    })
  ).toThrow();
  expect(() =>
    selectNativeComposeAfterHooks({
      host: { up: { before: [valid], after: [valid] } },
    })
  ).toThrow();
});

test("hooks run with non-portable inherited names and never receive them (HACK-2219)", async () => {
  // Bash exports a function f as BASH_FUNC_f%%; `env 'FOO%%=1'` is legal too.
  const root = await fixture();
  const names = ["BASH_FUNC_hack2219%%", "FOO%%", "HACK_2219_AMBIENT"];
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  );
  for (const name of names) {
    process.env[name] = "fixture-inherited";
  }
  try {
    expect(
      await execute(root, [
        hook("seen", {
          exec: [
            process.execPath,
            "-e",
            `await Bun.write("seen", JSON.stringify(${JSON.stringify(names)}.map((name) => process.env[name] ?? null)))`,
          ],
        }),
      ])
    ).toEqual({ outcome: "complete", value: 0 });
  } finally {
    for (const name of names) {
      restoreEnv(name, saved[name]);
    }
  }
  expect(JSON.parse(await readFile(join(root, "seen"), "utf8"))).toEqual([
    null,
    null,
    "fixture-inherited",
  ]);
});

test("a hook that sets a non-portable name is refused by that name, escaped, with no value", () => {
  const select = (variable: string) =>
    selectNativeComposeBeforeHooks({
      host: {
        up: {
          before: [
            {
              ...hook("odd", { shell: "true" }),
              environment: { [variable]: { literal: "fixture-secret-value" } },
            },
          ],
        },
      },
    });
  let refusal: unknown;
  try {
    select("FOO%%");
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(NativeEnvironmentNameError);
  const error = refusal as NativeEnvironmentNameError;
  expect(error.code).toBe("E_CONFIG_INVALID");
  expect(error.reason).toBe("environment_name_not_portable");
  expect(error.message).toContain(
    'Host command odd sets environment variable "FOO%%"'
  );
  expect(error.message).not.toContain("fixture-secret-value");
  expect(() => select("A\u001b[31m\u202e")).toThrow(
    'variable "A\\u{1b}[31m\\u{202e}"'
  );
});

test("wrong target report and unavailable endpoint owners refuse before value delivery", () => {
  const selected = hook("selected", { shell: "true" });
  const plan: NativeEnvironmentPlan = {
    ...environment([selected]),
    host: {
      selected: { env_target: { kind: "workload", name: "web" }, bindings: {} },
    },
  };
  expect(() =>
    assertNativeComposeBeforeHookBindings({
      hooks: [selected],
      environmentPlan: plan,
    })
  ).toThrow();
});
