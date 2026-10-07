import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { restoreEnv } from "./helpers/env.ts";
import {
  readUnmockedFsPromisesExport,
  registerScopedModuleMock,
} from "./helpers/scoped-module-mock.ts";

const realOpen = await readUnmockedFsPromisesExport("open");
let path: string;
let root: string;
let savedPath: string | undefined;
let mode: "replace" | "rewrite" | "parent" | "denied" | "cancel";
let closed = 0;
let controller = new AbortController();
const scoped = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "node:fs/promises",
  overrides: {
    open: async (...args: Parameters<typeof realOpen>) => {
      if (args[0] !== path) {
        return await realOpen(...args);
      }
      if (mode === "denied") {
        throw new Error("private-policy-sentinel");
      }
      if (mode === "replace") {
        await rename(path, `${path}-old`);
        await Bun.write(path, '{"default_domain":"other.invalid"}');
      }
      if (mode === "parent") {
        await rename(dirname(path), `${dirname(path)}-old`);
        await symlink(`${dirname(path)}-old`, dirname(path));
      }
      const file = await realOpen(...args);
      let changed = false;
      return new Proxy(file, {
        get: (handle, property) => {
          if (property === "close") {
            return async () => {
              closed++;
              await handle.close();
            };
          }
          if (property === "read") {
            return async (...readArgs: unknown[]) => {
              const result: unknown = await Reflect.apply(
                handle.read,
                handle,
                readArgs
              );
              if (!changed) {
                changed = true;
                if (mode === "rewrite") {
                  await Bun.write(path, '{"default_domain":"other.invalid"}');
                }
                if (mode === "cancel") {
                  controller.abort("private-policy-sentinel");
                }
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(handle, property, handle);
          return typeof value === "function" ? value.bind(handle) : value;
        },
      });
    },
  },
});
const { acquireNativeGlobalDomain } = await import(
  "../src/lib/native-routing-inputs.ts"
);
beforeAll(() => scoped.activate());
afterAll(() => scoped.deactivate());
beforeEach(async () => {
  savedPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  root = await realpath(await mkdtemp(join(tmpdir(), "native-routing-race-")));
  await mkdir(join(root, "policy"));
  path = join(root, "policy/config.json");
  await Bun.write(path, '{"default_domain":"first.invalid"}');
  process.env.HACK_GLOBAL_CONFIG_PATH = path;
  closed = 0;
  controller = new AbortController();
});
afterEach(async () => {
  restoreEnv("HACK_GLOBAL_CONFIG_PATH", savedPath);
  await rm(root, { recursive: true, force: true });
});
for (const mutation of [
  "replace",
  "rewrite",
  "parent",
  "denied",
  "cancel",
] as const) {
  test(`global routing policy ${mutation} refuses at acquisition boundary and closes owned descriptor`, async () => {
    mode = mutation;
    const error: unknown = await acquireNativeGlobalDomain({
      signal: controller.signal,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: mutation === "cancel" ? "E_COMPILER_CANCELLED" : "E_CONFIG_INPUT",
    });
    expect(String(error)).not.toContain("private-policy-sentinel");
    expect(String(error)).not.toContain(root);
    expect(closed).toBe(mutation === "denied" ? 0 : 1);
  });
}
