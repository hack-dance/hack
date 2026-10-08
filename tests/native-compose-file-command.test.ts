import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { isRecord } from "../src/lib/guards.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import {
  assertFileTransport,
  FILE_BYTES,
  FILE_CANARY,
  FILE_SOURCE,
  fileCommandFixture,
  fileCommandState,
  fileJournal,
  fileReference,
  invokeFiles,
  spawnFiles,
} from "./helpers/native-compose-files.ts";

function sources(document: unknown): string[] {
  if (
    !(
      isRecord(document) &&
      isRecord(document.services) &&
      isRecord(document.services.reader) &&
      Array.isArray(document.services.reader.volumes)
    )
  ) {
    throw new Error("Missing actual file binds");
  }
  return document.services.reader.volumes.map((volume: unknown) => {
    if (!(isRecord(volume) && typeof volume.source === "string")) {
      throw new Error("Invalid actual file bind");
    }
    return volume.source.replaceAll("$$", () => "$");
  });
}
function privateOutput(
  result: { readonly stdout: string; readonly stderr: string },
  document: unknown
) {
  const output = result.stdout + result.stderr;
  expect(output).not.toContain(FILE_CANARY);
  const ref = fileReference(document);
  expect(output).not.toContain(String(ref.root));
  if (isRecord(ref.manifest)) {
    expect(output).not.toContain(String(ref.manifest.digest));
  }
}
test("source CLI delivers actual acquired binary, managed and empty files with exact readonly mode; saved stop needs no source", async () => {
  const fixture = await fileCommandFixture();
  const up = await invokeFiles(fixture);
  expect(up.code).toBe(0);
  const ready = await fileCommandState(fixture.root);
  expect(ready.pending).toBeNull();
  expect(ready.current.stopped).toBe(false);
  expect(
    JSON.parse(await Bun.file(join(fixture.parent, "delivered")).text())
  ).toEqual([
    {
      target: "/etc/binary",
      bytes: Array.from(FILE_BYTES),
      mode: 0o444,
      readonly: true,
      create: false,
    },
    {
      target: "/run/token",
      bytes: Array.from(Buffer.from(FILE_CANARY)),
      mode: 0o444,
      readonly: true,
      create: false,
    },
    {
      target: "/run/empty",
      bytes: [],
      mode: 0o444,
      readonly: true,
      create: false,
    },
  ]);
  privateOutput(up, ready.document);
  const paths = sources(ready.document);
  for (const path of paths) {
    expect((await lstat(path)).mode & 0o777).toBe(0o444);
  }
  expect(await fileJournal(ready.document)).toContain('"phase":"reaped"');
  await rm(join(fixture.root, "binary"));
  await Bun.write(
    join(fixture.root, ".hack/hack.project.json"),
    "source deliberately unavailable"
  );
  await rm(join(fixture.root, ".hack/hack.env.default.yaml"));
  const down = await invokeFiles(fixture, ["down", "--recover", "--json"]);
  expect(down.code).toBe(0);
  privateOutput(down, ready.document);
  const stopped = await fileCommandState(fixture.root);
  expect(stopped.pending).toBeNull();
  expect(stopped.current.stopped).toBe(true);
  for (const path of paths) {
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await fileJournal(ready.document)).toContain('"phase":"retired"');
  await assertFileTransport(fixture);
}, 120_000);
test("unchanged authored file up acquires new bytes and retires its prior snapshot instead of reusing a warm generation", async () => {
  const fixture = await fileCommandFixture();
  expect((await invokeFiles(fixture)).code).toBe(0);
  const before = await fileCommandState(fixture.root);
  const oldPaths = sources(before.document);
  const changed = Uint8Array.from([9, 0, 255, 7]);
  await writeFile(join(fixture.root, "binary"), changed);
  const up = await invokeFiles(fixture);
  expect(up.code).toBe(0);
  const after = await fileCommandState(fixture.root);
  expect(after.current.generation?.generationId).not.toBe(
    before.current.generation?.generationId
  );
  expect(fileReference(after.document)).not.toEqual(
    fileReference(before.document)
  );
  expect(after.pending).toBeNull();
  expect(
    (await Bun.file(join(fixture.parent, "delivered")).json())[0].bytes
  ).toEqual(Array.from(changed));
  for (const path of oldPaths) {
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await fileJournal(before.document)).toContain('"phase":"retired"');
  expect(await fileJournal(after.document)).toContain('"phase":"reaped"');
  privateOutput(up, after.document);
  await assertFileTransport(fixture);
}, 120_000);
test("post-retirement engine drift refuses the completed stop receipt and preserves exact recovery even after material unlink", async () => {
  const fixture = await fileCommandFixture();
  expect((await invokeFiles(fixture)).code).toBe(0);
  const ready = await fileCommandState(fixture.root);
  const ref = fileReference(ready.document);
  await Bun.write(
    join(fixture.parent, "after-retirement-drift"),
    "change engine only after retirement"
  );
  const down = await invokeFiles(fixture, ["down", "--recover", "--json"]);
  expect(down.code).not.toBe(0);
  const interrupted = await fileCommandState(fixture.root);
  expect(interrupted.pending?.generationId).toBe(
    ready.current.generation?.generationId
  );
  expect(interrupted.current.stopped).toBe(false);
  expect(fileReference(interrupted.document)).toEqual(ref);
  expect(await fileJournal(interrupted.document)).toContain(
    '"phase":"retired"'
  );
  for (const path of sources(ready.document)) {
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
  await rm(join(fixture.parent, "after-retirement-drift"));
  const recovered = await invokeFiles(fixture, ["down", "--recover", "--json"]);
  expect(recovered.code).toBe(0);
  const stopped = await fileCommandState(fixture.root);
  expect(stopped.pending).toBeNull();
  expect(stopped.current.stopped).toBe(true);
  expect(fileReference(stopped.document)).toEqual(ref);
  await assertFileTransport(fixture);
}, 120_000);
test("a preexisting foreign ancestor bind refuses before any material member is staged or Compose child starts", async () => {
  const fixture = await fileCommandFixture();
  await Bun.write(
    join(fixture.parent, "foreign-source"),
    join(fixture.parent, "home")
  );
  const up = await invokeFiles(fixture);
  expect(up.code).not.toBe(0);
  await expect(
    lstat(join(fixture.parent, "home/compose-files"))
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await Bun.file(join(fixture.parent, "delivered")).exists()).toBe(
    false
  );
  const requests = await assertFileTransport(fixture);
  expect(requests.some((args) => args[0] === "compose")).toBe(false);
}, 120_000);
test.each([
  "late-mount-drift",
  "late-member-drift",
] as const)("%s after old material retirement prevents ready receipt and retains the new exact recovery reference", async (kind) => {
  const fixture = await fileCommandFixture();
  expect((await invokeFiles(fixture)).code).toBe(0);
  const before = await fileCommandState(fixture.root);
  const ref = fileReference(before.document);
  const journal = join(
    String(ref.root),
    `${ref.generationId}-${ref.snapshotToken}`,
    "journal.jsonl"
  );
  await Bun.write(join(fixture.parent, kind), journal);
  const result = await invokeFiles(fixture, ["restart", "--json"]);
  expect(result.code).not.toBe(0);
  expect(
    await Bun.file(join(fixture.parent, "late-drift-reached")).exists()
  ).toBe(true);
  expect(await fileJournal(before.document)).toContain('"phase":"retired"');
  const after = await fileCommandState(fixture.root);
  expect(after.pending).not.toBeNull();
  expect(after.pending?.generationId).not.toBe(
    before.current.generation?.generationId
  );
  expect(after.current.generation?.generationId).toBe(
    before.current.generation?.generationId
  );
  expect(after.current.stopped).toBe(false);
  expect(fileReference(after.document).generationId).toBe(
    after.pending?.generationId
  );
  expect(await fileJournal(after.document)).toContain('"phase":"reaped"');
  expect(await fileJournal(after.document)).not.toContain('"phase":"retiring"');
  privateOutput(result, after.document);
  await assertFileTransport(fixture);
}, 120_000);
test("an encrypted managed file with an unavailable project key refuses before staging, hooks or Docker", async () => {
  const fixture = await fileCommandFixture();
  const cipher = join(fixture.parent, "cipher");
  await mkdir(join(cipher, ".hack"), { recursive: true });
  const keyPath = join(cipher, PROJECT_ENV_KEY_FILENAME);
  await writeFile(keyPath, "synthetic-fixture-key-never-a-real-credential", {
    mode: 0o600,
  });
  await setProjectEnvValue({
    projectRoot: cipher,
    projectDir: join(cipher, ".hack"),
    envName: null,
    scope: "global",
    key: "TOKEN",
    value: FILE_CANARY,
    secret: true,
  });
  await writeFile(
    join(fixture.root, ".hack/hack.env.default.yaml"),
    await readFile(join(cipher, ".hack/hack.env.default.yaml"))
  );
  const result = await invokeFiles(fixture);
  expect(result.code).not.toBe(0);
  expect(await Bun.file(join(fixture.parent, "requests")).exists()).toBe(false);
  await expect(
    lstat(join(fixture.parent, "home/compose-files"))
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(result.stdout + result.stderr).not.toContain(FILE_CANARY);
}, 120_000);
test("a naturally reaped failed startup keeps pending and its exact material reference until verified saved stop", async () => {
  const fixture = await fileCommandFixture();
  await Bun.write(
    join(fixture.parent, "failed"),
    "fail startup after publication"
  );
  const up = await invokeFiles(fixture);
  expect(up.code).not.toBe(0);
  const failed = await fileCommandState(fixture.root);
  expect(failed.pending).not.toBeNull();
  expect(await fileJournal(failed.document)).toContain('"phase":"reaped"');
  const ref = fileReference(failed.document);
  await rm(join(fixture.root, "binary"));
  const down = await invokeFiles(fixture, ["down", "--recover", "--json"]);
  expect(down.code).toBe(0);
  const stopped = await fileCommandState(fixture.root);
  expect(stopped.pending).toBeNull();
  expect(fileReference(stopped.document)).toEqual(ref);
  expect(await fileJournal(failed.document)).toContain('"phase":"retired"');
  await assertFileTransport(fixture);
}, 120_000);
test("timed-out engine child never receives a reaping receipt; recovery stops resources and retains pending exact material", async () => {
  const fixture = await fileCommandFixture();
  await Bun.write(join(fixture.parent, "timeout"), "timeout the owned child");
  const up = await invokeFiles(fixture);
  expect(up.code).not.toBe(0);
  const failed = await fileCommandState(fixture.root);
  expect(failed.pending).not.toBeNull();
  expect(await fileJournal(failed.document)).toContain('"phase":"armed"');
  expect(await fileJournal(failed.document)).not.toContain('"phase":"reaped"');
  const ref = fileReference(failed.document);
  const paths = sources(failed.document);
  const down = await invokeFiles(fixture, ["down", "--recover", "--json"]);
  expect(down.code).not.toBe(0);
  expect(await Bun.file(join(fixture.parent, "engine")).exists()).toBe(false);
  const retained = await fileCommandState(fixture.root);
  expect(retained.pending?.generationId).toBe(failed.pending?.generationId);
  expect(fileReference(retained.document)).toEqual(ref);
  for (const path of paths) {
    expect((await lstat(path)).isFile()).toBe(true);
  }
  expect(await fileJournal(retained.document)).not.toContain(
    '"phase":"retiring"'
  );
  privateOutput(down, failed.document);
  await assertFileTransport(fixture);
}, 120_000);
test("missing managed authority and unsupported inactive builds refuse before material staging or Docker", async () => {
  for (const unsupported of [false, true]) {
    const fixture = await fileCommandFixture(
      unsupported
        ? {
            ...FILE_SOURCE,
            services: {
              ...FILE_SOURCE.services,
              inactive: {
                profiles: ["disabled"],
                build: { context: "." },
              },
            },
            profiles: ["disabled"],
          }
        : FILE_SOURCE
    );
    if (!unsupported) {
      await Bun.write(
        join(fixture.root, ".hack/hack.env.default.yaml"),
        JSON.stringify({
          version: 1,
          environment: "default",
          secretsprovider: "project_key",
          values: { global: { EMPTY: "" } },
        })
      );
    }
    await rm(join(fixture.root, "binary"));
    const result = await invokeFiles(fixture);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      unsupported
        ? "E_NATIVE_PROJECT_UNSUPPORTED"
        : "Native execution inputs are invalid or changed"
    );
    expect(await Bun.file(join(fixture.parent, "requests")).exists()).toBe(
      false
    );
    await expect(
      lstat(join(fixture.parent, "home/compose-files"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.stdout + result.stderr).not.toContain(FILE_CANARY);
  }
}, 120_000);
test("a replacement without file inputs retires the previous snapshot before generation handoff despite unavailable old sources", async () => {
  const fixture = await fileCommandFixture();
  expect((await invokeFiles(fixture)).code).toBe(0);
  const first = await fileCommandState(fixture.root);
  const paths = sources(first.document);
  await rm(join(fixture.root, "binary"));
  await rm(join(fixture.root, ".hack/hack.env.default.yaml"));
  await Bun.write(
    join(fixture.root, ".hack/hack.project.json"),
    JSON.stringify({
      schema_version: 1,
      name: "files",
      worktree: { auto_branch: false },
      services: { reader: { image: "synthetic/reader:2" } },
    })
  );
  const replacement = await invokeFiles(fixture);
  expect(replacement.code).toBe(0);
  const ready = await fileCommandState(fixture.root);
  expect(ready.pending).toBeNull();
  expect(ready.current.generation?.generationId).not.toBe(
    first.current.generation?.generationId
  );
  expect(ready.document).not.toHaveProperty("x-hack-native-files");
  expect(await fileJournal(first.document)).toContain('"phase":"retired"');
  for (const path of paths) {
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
  await assertFileTransport(fixture);
}, 120_000);
test("unknown after-hook completion vetoes material retirement after a verified owned stop", async () => {
  const fixture = await fileCommandFixture({
    ...FILE_SOURCE,
    host: {
      up: {
        after: [
          {
            name: "unknown",
            command: {
              exec: [
                process.execPath,
                "-e",
                'await Bun.write("../hook-started","started"); await Bun.sleep(1500)',
              ],
            },
          },
        ],
      },
    },
  });
  const child = spawnFiles(fixture);
  const deadline = Date.now() + 15_000;
  while (
    !(await Bun.file(join(fixture.parent, "hook-started")).exists()) &&
    child.exitCode === null &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
  }
  expect(await Bun.file(join(fixture.parent, "hook-started")).exists()).toBe(
    true
  );
  child.kill("SIGKILL");
  await child.exited;
  await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const failed = await fileCommandState(fixture.root);
  expect(failed.current.hostHookPhase).toBe("after");
  expect(failed.pending).not.toBeNull();
  expect(await fileJournal(failed.document)).toContain('"phase":"reaped"');
  const paths = sources(failed.document);
  const down = await invokeFiles(fixture, ["down", "--recover", "--json"]);
  expect(down.code).not.toBe(0);
  expect(await Bun.file(join(fixture.parent, "engine")).exists()).toBe(false);
  const retained = await fileCommandState(fixture.root);
  expect(retained.current.hostHookPhase).toBe("after");
  expect(retained.pending?.generationId).toBe(failed.pending?.generationId);
  expect(fileReference(retained.document)).toEqual(
    fileReference(failed.document)
  );
  expect(await fileJournal(retained.document)).not.toContain(
    '"phase":"retiring"'
  );
  for (const path of paths) {
    expect((await lstat(path)).isFile()).toBe(true);
  }
  await assertFileTransport(fixture);
}, 120_000);
test("before hooks may create file sources without an earlier material read", async () => {
  const fixture = await fileCommandFixture({
    ...FILE_SOURCE,
    host: {
      up: {
        before: [
          {
            name: "create",
            command: {
              exec: [
                process.execPath,
                "-e",
                'await Bun.write("binary",new Uint8Array([8,0,9]))',
              ],
            },
          },
        ],
      },
    },
  });
  await rm(join(fixture.root, "binary"));
  const up = await invokeFiles(fixture);
  expect(up.code).toBe(0);
  const delivered: unknown = JSON.parse(
    await Bun.file(join(fixture.parent, "delivered")).text()
  );
  expect(Array.isArray(delivered) ? delivered[0] : undefined).toMatchObject({
    bytes: [8, 0, 9],
  });
  await assertFileTransport(fixture);
}, 120_000);
test("one-off file run refuses before hooks, material acquisition or engine calls", async () => {
  const fixture = await fileCommandFixture();
  const result = await invokeFiles(fixture, ["run", "reader"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain(
    "file material is not qualified"
  );
  expect(await Bun.file(join(fixture.parent, "requests")).exists()).toBe(false);
  await expect(
    lstat(join(fixture.parent, "home/compose-files"))
  ).rejects.toMatchObject({ code: "ENOENT" });
}, 120_000);
test.each([
  "stop-timeout",
  "stop-orphan",
] as const)("%s retains exact pending material after stop; another down cannot hand off the unknown stop child", async (kind) => {
  const fixture = await fileCommandFixture();
  expect((await invokeFiles(fixture)).code).toBe(0);
  const ready = await fileCommandState(fixture.root);
  await Bun.write(join(fixture.parent, kind), "make stop completion unknown");
  const down = await invokeFiles(fixture, ["down", "--recover", "--json"]);
  expect(down.code).not.toBe(0);
  expect(await Bun.file(join(fixture.parent, "engine")).exists()).toBe(false);
  const interrupted = await fileCommandState(fixture.root);
  expect(interrupted.pending?.generationId).toBe(
    ready.current.generation?.generationId
  );
  expect(fileReference(interrupted.document)).toEqual(
    fileReference(ready.document)
  );
  expect(await fileJournal(interrupted.document)).toContain(
    '"phase":"stop-armed"'
  );
  expect(await fileJournal(interrupted.document)).not.toContain(
    '"phase":"stop-reaped"'
  );
  await rm(join(fixture.parent, kind));
  const retry = await invokeFiles(fixture, ["down", "--recover", "--json"]);
  expect(retry.code).not.toBe(0);
  const retained = await fileCommandState(fixture.root);
  expect(retained.pending?.generationId).toBe(
    interrupted.pending?.generationId
  );
  expect(fileReference(retained.document)).toEqual(
    fileReference(ready.document)
  );
  expect(await fileJournal(retained.document)).not.toContain(
    '"phase":"stop-reaped"'
  );
  expect(await fileJournal(retained.document)).not.toContain(
    '"phase":"retiring"'
  );
  for (const path of sources(ready.document)) {
    expect((await lstat(path)).isFile()).toBe(true);
  }
  await assertFileTransport(fixture);
}, 120_000);
