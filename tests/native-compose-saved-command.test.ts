import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function savedFixture(outcome: "complete" | "uncertain" = "complete") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-saved-command-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    "invalid authored input must not be parsed on saved operations"
  );
  const owner = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "prepare",
  });
  await owner.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const rendered = renderNativeCompose({
      ...composeFixture(),
      projectRoot: root,
      runtimeIdentity: owner.identity.composeProject,
      generationIdentity: reservation.generationId,
      ownerToken: owner.identity.ownerToken,
    });
    const generation = await mutation.publish({
      reservation,
      composeJson: rendered.json,
      profiles: [],
      inputRevision: createHash("sha256").update("fixture").digest("hex"),
      assertFresh: async () => {},
    });
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => ({ outcome, value: 0 }),
    });
  });
  const leases = join(
    root,
    ".hack/.internal/native-compose",
    owner.identity.instanceId,
    "leases"
  );
  await owner.close();
  const binary = join(root, "docker");
  await Bun.write(
    binary,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "compose") process.exit(0);
writeFileSync(${JSON.stringify(join(root, "started"))}, String(process.pid));
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(join(root, "stopped"))}, "reaped"); process.exit(143); });
await Bun.sleep(60_000);
`
  );
  await chmod(binary, 0o700);
  return { root, leases };
}

test("saved ps reports pending state after an incomplete first startup", async () => {
  const { root, leases } = await savedFixture("uncertain");
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../index.ts"), "ps", "--json"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await stdout)).toMatchObject({
    ok: true,
    data: { stopped: true, pending: true, services: [] },
  });
  expect(await stderr).not.toContain("invalid authored input");
  expect(await readdir(leases)).toEqual([]);
}, 20_000);

test.each([
  "exec",
  "logs",
  "ps",
] as const)("saved %s forwards cancellation, reaps its child and releases the lease", async (operation) => {
  const { root, leases } = await savedFixture();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      operation,
      ...(operation === "exec" ? ["web", "--", "sleep", "60"] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  const deadline = Date.now() + 15_000;
  let pid = 0;
  while (Date.now() < deadline && child.exitCode === null) {
    if (await Bun.file(join(root, "started")).exists()) {
      pid = Number(await readFile(join(root, "started"), "utf8"));
      break;
    }
    await Bun.sleep(20);
  }
  expect(pid).toBeGreaterThan(1);
  expect((await readdir(leases)).length).toBe(1);
  child.kill("SIGTERM");
  const exit = await Promise.race([
    child.exited,
    Bun.sleep(5000).then(() => -1),
  ]);
  const outputs = await Promise.all([stdout, stderr]);
  expect(exit).toBe(143);
  expect(await Bun.file(join(root, "stopped")).text()).toBe("reaped");
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await readdir(leases)).toEqual([]);
  expect(outputs.join("")).not.toContain("invalid authored input");
}, 20_000);
