import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { machineData, machineError } from "./helpers/machine-output.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const cli = resolve(import.meta.dir, "..", "index.ts");
const firstReplica = "b".repeat(64);
const secondReplica = "a".repeat(64);
const directory = "/app\x0041ed:10:32\0";

let root: string;
let project: string;
let docker: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-files-")));
  project = join(root, "checkout");
  docker = join(root, "docker");
  await mkdir(join(project, ".hack"), { recursive: true });
  await mkdir(join(root, "checkout-elsewhere"));
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    "name: files-test\nservices:\n  api:\n    image: alpine\n"
  );
  await writeFile(
    docker,
    `#!/bin/sh
set -eu
case "$1" in
  ps)
    case "$*" in
      *"label=com.docker.compose.project=files-test--branch "*"label=com.docker.compose.service=api "*"label=com.docker.compose.oneoff=False "*) ;;
      *) exit 0 ;;
    esac
    printf '%s 2\\n%s 1\\n' '${secondReplica}' '${firstReplica}'
    ;;
  inspect)
    shift 5
    [ "$1" = '${firstReplica}' ] || exit 1
    cat "$FILES_FIXTURE/mounts"
    ;;
  exec)
    [ "$2" = '${firstReplica}' ] || exit 1
    shift 10
    [ "$1" = "$FILES_PATH" ] || exit 1
    cat "$FILES_FIXTURE/output"
    exit "$FILES_EXIT"
    ;;
  *) exit 1 ;;
esac
`
  );
  await chmod(docker, 0o755);
  await writeFile(
    join(root, "mounts"),
    JSON.stringify({
      mounts: [
        { Type: "bind", Destination: "/app", Source: project },
        { Type: "volume", Destination: "/app/cache", Name: "files-test_cache" },
        {
          Type: "volume",
          Destination: "/app/anonymous",
          Name: "anonymous-volume-id",
        },
        {
          Type: "bind",
          Destination: "/app/outside",
          Source: join(root, "checkout-elsewhere"),
        },
        { Type: "volume", Destination: "/app/cargo", Name: "cargo-data" },
      ],
      configured: [{ Type: "volume", Source: "cargo-data" }],
      binds: ["files-test_cache:/app/cache:rw"],
      tmpfs: { "/app/tmp": "rw" },
    })
  );
});

afterEach(() => rm(root, { force: true, recursive: true }));

async function run(opts: {
  readonly operation: "ls" | "cat";
  readonly path: string;
  readonly output: string | Buffer;
  readonly status?: number;
  readonly branch?: boolean;
}) {
  await writeFile(join(root, "output"), opts.output);
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "files",
      opts.operation,
      "--json",
      "--path",
      project,
      ...(opts.branch === false ? [] : ["--branch", "branch"]),
      "--",
      "api",
      opts.path,
    ],
    {
      cwd: root,
      env: privateCliEnv({
        root,
        env: {
          PATH: `${root}:/usr/bin:/bin`,
          FILES_FIXTURE: root,
          FILES_PATH: opts.path,
          FILES_EXIT: String(opts.status ?? 0),
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("files ls scopes the branch and replica, and classifies the deepest actual mount", async () => {
  const output =
    directory +
    [
      "/app/.hidden",
      "/app/line\nwith space",
      "/app/cache",
      "/app/cache-old",
      "/app/tmp",
      "/app/anonymous",
      "/app/outside",
      "/app/cargo",
    ]
      .map(
        (path) =>
          `${path}\0${path.endsWith("space") ? "81a4:6:32" : "41ed:10:32"}\0`
      )
      .join("");
  const result = await run({ operation: "ls", path: ".", output });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const data = machineData(result.stdout, "hack.files.v1");
  expect(data.service).toBe("api");
  expect(data.operation).toBe("ls");
  expect(data.entry).toMatchObject({
    path: "/app",
    source: "worktree",
    hostPath: project,
  });
  expect(data.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: ".hidden", source: "worktree" }),
      expect.objectContaining({
        name: "line\nwith space",
        source: "worktree",
        kind: "file",
        sizeBytes: 6,
        modifiedAtMs: 32_000,
        hostPath: join(project, "line\nwith space"),
      }),
      expect.objectContaining({
        name: "cache",
        source: "volume",
        hostPath: null,
      }),
      expect.objectContaining({
        name: "cargo",
        source: "volume",
        hostPath: null,
      }),
      expect.objectContaining({ name: "cache-old", source: "worktree" }),
      expect.objectContaining({
        name: "tmp",
        source: "container",
        hostPath: null,
      }),
      expect.objectContaining({
        name: "outside",
        source: "container",
        hostPath: null,
      }),
      expect.objectContaining({
        name: "anonymous",
        source: "container",
        hostPath: null,
      }),
    ])
  );
}, 60_000);

test("files cat preserves binary bytes and tags the resolved symlink target", async () => {
  const result = await run({
    operation: "cat",
    path: "--literal path",
    output: Buffer.concat([
      Buffer.from("/tmp/binary\x0081a4:3:32\0"),
      Buffer.from([0, 1, 255]),
    ]),
  });
  expect(result.exitCode).toBe(0);
  expect(machineData(result.stdout, "hack.files.v1")).toMatchObject({
    operation: "cat",
    encoding: "base64",
    content: "AAH/",
    truncated: false,
    entry: { path: "/tmp/binary", source: "container", hostPath: null },
  });
}, 60_000);

test("files cat returns a bounded UTF-8 prefix without a partial codepoint", async () => {
  const prefix = "x".repeat(65_535);
  const result = await run({
    operation: "cat",
    path: "/app/large",
    output: Buffer.concat([
      Buffer.from("/app/large\x0081a4:65538:32\0"),
      Buffer.from(prefix),
      Buffer.from([226, 130]),
    ]),
  });
  expect(result.exitCode).toBe(0);
  expect(machineData(result.stdout, "hack.files.v1")).toMatchObject({
    encoding: "utf8",
    content: prefix,
    truncated: true,
  });
}, 60_000);

test.each([
  { status: 65, code: "E_USAGE" },
  { status: 66, code: "E_COMPOSE_FAILED" },
  { status: 75, code: "E_COMPOSE_FAILED" },
  { status: 77, code: "E_PERMISSION" },
])("files refuses failed reads ($status) without returning output", async ({
  status,
  code,
}) => {
  const result = await run({
    operation: "ls",
    path: ".",
    output: directory,
    status,
  });
  expect(result.exitCode).not.toBe(0);
  machineError(result.stdout, code);
  expect(result.stdout).not.toContain("/app");
}, 60_000);

test("files never falls back to a different Compose instance", async () => {
  const result = await run({
    operation: "ls",
    path: ".",
    output: directory,
    branch: false,
  });
  expect(result.exitCode).not.toBe(0);
  machineError(result.stdout, "E_SERVICE_NOT_FOUND");
}, 60_000);
