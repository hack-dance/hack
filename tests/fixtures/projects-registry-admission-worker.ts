import { mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { basename, join } from "node:path";

const [
  registryDir,
  projectRoot,
  operation = "touch",
  nowIso = "2026-01-01T00:02:00Z",
] = process.argv.slice(2);
if (!(registryDir && projectRoot)) {
  throw new Error("Missing isolated admission fixture paths");
}
const registryPath = join(registryDir, "projects.json");
const lockPath = `${registryPath}.lock`;
const projectDir = join(projectRoot, ".hack");
const configFile = join(projectDir, "hack.config.json");
const controller = new AbortController();
const mutations: string[] = [];
let ownerOpens = 0;
let publications = 0;
let registryWrites = 0;
let realpaths = 0;
let observations = 0;
const real = {
  lstat: fs.lstat,
  realpath: fs.realpath,
  mkdir: fs.mkdir,
  rmdir: fs.rmdir,
  open: fs.open,
  link: fs.link,
  unlink: fs.unlink,
  rename: fs.rename,
};

// Spies retain Bun's real implementations; subprocess results are never fabricated.
const launches = spyOn(Bun, "spawn");
const files = spyOn(Bun, "file");
const writes = spyOn(Bun, "write");
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function isConfigFile(path: unknown): boolean {
  return typeof path === "string" && path === configFile;
}
async function pauseObservation(
  observed: { ok: true } | { ok: false; error: unknown }
) {
  if (!(observed.ok || hasCode(observed.error, "ENOENT"))) {
    throw observed.error;
  }
  process.stdout.write(`observed-${observed.ok ? "occupied" : "absent"}\n`);
  await Bun.stdin.text();
}
mock.module("node:fs/promises", () => ({
  ...fs,
  lstat: async (path: string) => {
    const observed = await real.lstat(path).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    if (path === lockPath) {
      observations++;
      if (
        (operation === "pause-early" && observations === 1) ||
        (operation === "pause-late" && observations === 2)
      ) {
        await pauseObservation(observed);
      }
    }
    if (!observed.ok) {
      throw observed.error;
    }
    return observed.value;
  },
  realpath: async (path: string) => {
    realpaths++;
    return await real.realpath(path);
  },
  mkdir: async (
    path: string,
    options: { recursive?: boolean; mode?: number }
  ) => {
    mutations.push("mkdir");
    return await real.mkdir(path, options);
  },
  rmdir: async (path: string) => {
    mutations.push("rmdir");
    return await real.rmdir(path);
  },
  open: async (path: string, flags: string | number, mode?: number) => {
    if (path.startsWith(`${lockPath}.`) && path.endsWith(".owner")) {
      ownerOpens++;
    }
    if (path.startsWith(`${registryPath}.`) && path.endsWith(".tmp")) {
      registryWrites++;
    }
    if (typeof flags === "string" && flags.includes("w")) {
      mutations.push("open-write");
    }
    return await real.open(path, flags, mode);
  },
  link: async (from: string, to: string) => {
    publications++;
    mutations.push("link");
    try {
      return await real.link(from, to);
    } catch (error) {
      if (operation === "required" && hasCode(error, "EEXIST")) {
        controller.abort(
          new Error("required writer reached occupied publication")
        );
      }
      throw error;
    }
  },
  unlink: async (path: string) => {
    mutations.push("unlink");
    return await real.unlink(path);
  },
  rename: async (from: string, to: string) => {
    mutations.push("rename");
    return await real.rename(from, to);
  },
}));

const { touchProjectRegistration, upsertProjectRegistration } = await import(
  "../../src/lib/projects-registry.ts"
);
const project = {
  projectRoot,
  projectDirName: ".hack" as const,
  projectDir,
  configFile,
  composeFile: join(projectDir, "docker-compose.yml"),
  envFile: join(projectDir, ".env"),
};
let result: unknown = null;
let error: string | null = null;
if (operation === "aborted") {
  controller.abort(new Error("cancelled before registry admission"));
}
try {
  result =
    operation === "optional" ||
    operation === "required" ||
    operation === "aborted"
      ? await upsertProjectRegistration({
          project,
          nowIso,
          waitForLock: operation === "required",
          signal: controller.signal,
        })
      : await touchProjectRegistration({ project, nowIso });
} catch (failure) {
  error = failure instanceof Error ? failure.message : "unexpected failure";
}
const gitLaunches = launches.mock.calls.filter(
  ([argv]) => Array.isArray(argv) && basename(String(argv[0])) === "git"
).length;
process.stdout.write(
  `${JSON.stringify({ result, error, gitLaunches, subprocesses: launches.mock.calls.length, configReads: files.mock.calls.filter(([path]) => isConfigFile(path)).length, bunWrites: writes.mock.calls.length, realpaths, observations, ownerOpens, publications, registryWrites, mutations })}\n`
);
