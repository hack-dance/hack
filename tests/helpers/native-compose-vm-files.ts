import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { restoreEnv } from "./env.ts";

const cleanups: (() => Promise<void>)[] = [];
/** Register this in each test file; Bun caches imports but scopes test hooks. */
export async function cleanupVmFileFixtures() {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
}
const environmentKeys = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CUSTOM_HEADERS",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_CONFIG_COMPILER_BINARY",
  "HACK_ENV_SECRET_KEY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "HACK_TEST_VM_ROOT",
] as const;
export const VM_ENGINE = "synthetic-vm-file-engine:1";
export const VM_BYTES = Buffer.from([0, 255, 9, 10]);

/** No physical Docker handle exists. All accepted commands are fixed fixture
 * protocol, and real owned children still use the production bounded client. */
export async function vmFileFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-vm-files-"))
  );
  const saved = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]])
  );
  const compiler = resolve(
    process.env.HACK_CONFIG_COMPILER_BINARY ?? "dist/hack-config-compiler"
  );
  for (const key of environmentKeys) {
    Reflect.deleteProperty(process.env, key);
  }
  await mkdir(join(root, "home"), { mode: 0o700 });
  await mkdir(join(root, "client"), { mode: 0o700 });
  await writeFile(join(root, "client/config.json"), "{}", { mode: 0o600 });
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, ".hack"), { recursive: true });
  await writeFile(join(checkout, "settings"), VM_BYTES, { mode: 0o600 });
  await writeFile(
    join(checkout, ".hack/hack.project.json"),
    JSON.stringify({
      schema_version: 1,
      name: "vmfiles",
      configs: { settings: { file: "settings" } },
      services: {
        reader: {
          image: "synthetic/reader:1",
          mounts: [
            {
              config: "settings",
              target: "/etc/settings",
              access: "read-only",
              mode: "0400",
            },
          ],
        },
      },
    })
  );
  const socket = join(root, "engine.sock");
  let requests = 0;
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      requests++;
      if (new URL(request.url).pathname !== "/info") {
        return new Response("", { status: 404 });
      }
      return Response.json({ ID: VM_ENGINE });
    },
  });
  cleanups.push(async () => {
    server.stop(true);
    for (const key of environmentKeys) {
      restoreEnv(key, saved[key]);
    }
    await rm(root, { recursive: true, force: true });
  });
  const docker = join(root, "docker");
  await writeFile(
    docker,
    "#!" +
      process.execPath +
      "\nimport " +
      JSON.stringify(resolve(import.meta.dir, "native-compose-vm-docker.ts")) +
      ";\n",
    { mode: 0o700 }
  );
  await chmod(docker, 0o700);
  process.env.PATH = `${root}:/usr/bin:/bin`;
  process.env.HOME = join(root, "home");
  process.env.DOCKER_HOST = `unix://${socket}`;
  process.env.DOCKER_CONFIG = join(root, "client");
  process.env.HACK_HOME = join(root, "home");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "global.json");
  process.env.HACK_CONFIG_COMPILER_BINARY = compiler;
  process.env.HACK_TEST_VM_ROOT = root;
  return {
    root,
    checkout,
    requests: () => requests,
    unmark: async (name: string) => await unlink(join(root, name)),
    mark: async (name: string) =>
      await writeFile(join(root, name), "synthetic"),
    commands: async () => {
      const text = await readFile(join(root, "commands.jsonl"), "utf8");
      return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    },
    state: async () =>
      JSON.parse(await readFile(join(root, "engine.json"), "utf8")) as unknown,
  };
}
