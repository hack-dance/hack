import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createTicketsStore } from "../src/control-plane/extensions/tickets/store.ts";
import { readControlPlaneConfig } from "../src/control-plane/sdk/config.ts";

const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const generatedTicketIds: string[] = [];
const logger = {
  info: (_input: { message: string }) => {},
  warn: (_input: { message: string }) => {},
};

let tempGlobalConfigPath: string | null = null;
let tempRoots: string[] = [];

beforeEach(() => {
  generatedTicketIds.length = 0;
  tempGlobalConfigPath = join(
    tmpdir(),
    `hack-global-config-${Date.now()}-${Math.random()}.json`
  );
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfigPath;
});

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots = [];

  if (tempGlobalConfigPath) {
    await rm(tempGlobalConfigPath, { force: true });
    tempGlobalConfigPath = null;
  }

  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
});

test("tickets store retries generated ids that collide during concurrent creates", async () => {
  generatedTicketIds.push("T-AAAAAAAAAA", "T-AAAAAAAAAA", "T-BBBBBBBBBB");

  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-id-collision-",
  });
  const store = await createStore({ projectRoot });

  const results = await Promise.all([
    store.createTicket({
      title: "First concurrent ticket",
      owner: "hack",
      source: "hack",
      actor: "creator-1@hack",
    }),
    store.createTicket({
      title: "Second concurrent ticket",
      owner: "hack",
      source: "hack",
      actor: "creator-2@hack",
    }),
  ]);

  expect(results.every((result) => result.ok)).toBe(true);

  const ticketIds = results.flatMap((result) =>
    result.ok ? [result.ticket.ticketId] : []
  );
  expect(ticketIds).toHaveLength(2);
  expect(new Set(ticketIds)).toEqual(new Set(["T-AAAAAAAAAA", "T-BBBBBBBBBB"]));

  const tickets = await store.listTickets();
  expect(tickets.map((ticket) => ticket.ticketId)).toEqual([
    "T-AAAAAAAAAA",
    "T-BBBBBBBBBB",
  ]);
}, 20_000);

async function createStore(opts: { readonly projectRoot: string }) {
  const configResult = await readControlPlaneConfig({
    projectDir: join(opts.projectRoot, ".hack"),
  });
  return createTicketsStore({
    projectRoot: opts.projectRoot,
    controlPlaneConfig: configResult.config,
    generateTicketId: () => generatedTicketIds.shift() ?? "T-ZZZZZZZZZZ",
    logger,
  });
}

async function createTempGitProject(opts: {
  readonly prefix: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), opts.prefix));
  tempRoots.push(root);
  await copyDir({
    from: resolve(import.meta.dir, "../examples/tickets"),
    to: root,
  });
  await run({ cwd: root, cmd: ["git", "init"] });
  await run({ cwd: root, cmd: ["git", "config", "user.email", "tests@hack"] });
  await run({
    cwd: root,
    cmd: ["git", "config", "user.name", "hack-cli-tests"],
  });
  await run({ cwd: root, cmd: ["git", "add", "-A"] });
  await run({ cwd: root, cmd: ["git", "commit", "-m", "init"] });
  return root;
}

async function run(opts: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}) {
  const proc = Bun.spawn([...opts.cmd], {
    cwd: opts.cwd,
    env: process.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): ${opts.cmd.join(" ")}\n${stderr || stdout}`
    );
  }
}

async function copyDir(opts: {
  readonly from: string;
  readonly to: string;
}): Promise<void> {
  await mkdir(opts.to, { recursive: true });
  const entries = await readdir(opts.from, { withFileTypes: true });
  for (const entry of entries) {
    const fromPath = join(opts.from, entry.name);
    const toPath = join(opts.to, entry.name);
    if (entry.isDirectory()) {
      await copyDir({ from: fromPath, to: toPath });
    } else if (entry.isFile()) {
      const data = await readFile(fromPath);
      await writeFile(toPath, data);
    }
  }
}
