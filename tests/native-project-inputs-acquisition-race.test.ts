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
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  readUnmockedFsPromisesExport,
  registerScopedModuleMock,
} from "./helpers/scoped-module-mock.ts";

type AcquisitionChange = "replace" | "rewrite" | "parent" | "denied";
let root: string;
let targetFile: string | null = null;
let change: AcquisitionChange = "replace";
let closedFiles = 0;
const realOpen = await readUnmockedFsPromisesExport("open");

const fileMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "node:fs/promises",
  overrides: {
    open: async (...args: Parameters<typeof realOpen>) => {
      const path = args[0];
      const target = path === targetFile;
      if (target && typeof path === "string") {
        if (change === "denied") {
          throw new Error(`authored-canary: denied ${path}`);
        }
        if (change === "replace") {
          await rm(path);
          await Bun.write(path, "authored-canary-replacement\n");
        } else if (change === "parent") {
          const original = dirname(path);
          const displaced = `${original}-displaced`;
          await rename(original, displaced);
          await symlink(displaced, original);
        }
      }
      const file = await realOpen(...args);
      if (!target || typeof path !== "string") {
        return file;
      }
      let rewritten = false;
      return new Proxy(file, {
        get: (handle, property) => {
          if (property === "close") {
            return async () => {
              closedFiles += 1;
              await handle.close();
            };
          }
          if (property === "read" && change === "rewrite") {
            return async (...readArgs: unknown[]) => {
              const result: unknown = await Reflect.apply(
                handle.read,
                handle,
                readArgs
              );
              if (!rewritten) {
                rewritten = true;
                await Bun.write(path, '{"a":2}\n');
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

const { acquireNativeLocalInputs, acquireNativeProjectInput } = await import(
  "../src/lib/native-project-inputs.ts"
);

beforeAll(() => fileMock.activate());
afterAll(() => fileMock.deactivate());
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "native-input-race-")));
  targetFile = null;
  closedFiles = 0;
  await mkdir(join(root, ".hack"));
  await Bun.write(join(root, ".hack", "hack.project.json"), '{"a":1}\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

for (const role of ["project", "checkout-local"] as const) {
  for (const mutation of ["replace", "rewrite", "parent", "denied"] as const) {
    test(`${role} acquisition refuses ${mutation} at the descriptor boundary and closes owned files`, async () => {
      targetFile = join(
        root,
        ".hack",
        role === "project" ? "hack.project.json" : "hack.local.json"
      );
      if (role === "checkout-local") {
        await Bun.write(targetFile, '{"a":1}\n');
      }
      change = mutation;
      try {
        if (role === "project") {
          await acquireNativeProjectInput({ startDir: root });
        } else {
          await acquireNativeLocalInputs({
            projectRoot: root,
            inheritLocal: false,
          });
        }
        throw new Error("Unexpected acquisition success");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(HackCliError);
        expect(error).toHaveProperty("code", "E_CONFIG_INVALID");
        expect(String(error)).not.toContain(root);
        expect(String(error)).not.toContain("authored-canary");
      }
      expect(closedFiles).toBe(mutation === "denied" ? 0 : 1);
    });
  }
}
