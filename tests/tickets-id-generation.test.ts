import { afterEach, expect, test } from "bun:test";
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
import { createDefaultControlPlaneConfig } from "../src/control-plane/sdk/config.ts";

const logger = {
  info: (_input: { message: string }) => {},
  warn: (_input: { message: string }) => {},
};

let tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

test("tickets store retries generated ids that collide with an existing local ticket", async () => {
  const generatedTicketIds = ["T-AAAAAAAAAA", "T-AAAAAAAAAA", "T-BBBBBBBBBB"];

  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-id-collision-",
  });
  const store = await createStore({
    projectRoot,
    generateTicketId: () => generatedTicketIds.shift() ?? "T-ZZZZZZZZZZ",
  });

  const first = await store.createTicket({
    title: "First ticket",
    owner: "hack",
    source: "hack",
    actor: "creator-1@hack",
  });
  expect(first.ok).toBe(true);

  const second = await store.createTicket({
    title: "Second ticket",
    owner: "hack",
    source: "hack",
    actor: "creator-2@hack",
  });
  expect(second.ok).toBe(true);

  const tickets = await store.listTickets();
  expect(tickets.map((ticket) => ticket.ticketId)).toEqual([
    "T-AAAAAAAAAA",
    "T-BBBBBBBBBB",
  ]);
}, 20_000);

test("tickets store reallocates ticket ids after a push retry sees a remote collision", async () => {
  const remoteRoot = await mkdtemp(join(tmpdir(), "hack-cli-tickets-remote-"));
  tempRoots.push(remoteRoot);
  await run({ cwd: remoteRoot, cmd: ["git", "init", "--bare"] });

  const projectRootA = await createTempGitProject({
    prefix: "hack-cli-tickets-remote-a-",
    remoteRoot,
  });
  const projectRootB = await createTempGitProject({
    prefix: "hack-cli-tickets-remote-b-",
    remoteRoot,
  });

  const storeA = await createStore({
    projectRoot: projectRootA,
    generateTicketId: () => "T-AAAAAAAAAA",
  });
  const storeB = await createStore({
    projectRoot: projectRootB,
    generateTicketId: (() => {
      const generatedIds = ["T-AAAAAAAAAA", "T-BBBBBBBBBB"];
      return () => generatedIds.shift() ?? "T-CCCCCCCCCC";
    })(),
  });

  expect(await storeB.listTickets()).toEqual([]);

  const createdA = await storeA.createTicket({
    title: "First repo ticket",
    owner: "hack",
    source: "hack",
    actor: "creator-a@hack",
  });
  expect(createdA.ok).toBe(true);

  const createdB = await storeB.createTicket({
    title: "Second repo ticket",
    owner: "hack",
    source: "hack",
    actor: "creator-b@hack",
  });
  expect(createdB.ok).toBe(true);
  if (!(createdA.ok && createdB.ok)) {
    throw new Error("Expected both ticket creates to succeed");
  }

  expect(createdA.ticket.ticketId).toBe("T-AAAAAAAAAA");
  expect(createdB.ticket.ticketId).toBe("T-BBBBBBBBBB");

  const tickets = await storeB.listTickets();
  expect(tickets.map((ticket) => ticket.ticketId)).toEqual([
    "T-AAAAAAAAAA",
    "T-BBBBBBBBBB",
  ]);
}, 20_000);

async function createStore(opts: {
  readonly projectRoot: string;
  readonly generateTicketId?: () => string;
}) {
  return createTicketsStore({
    projectRoot: opts.projectRoot,
    controlPlaneConfig: createDefaultControlPlaneConfig(),
    generateTicketId: opts.generateTicketId ?? (() => "T-ZZZZZZZZZZ"),
    logger,
  });
}

async function createTempGitProject(opts: {
  readonly prefix: string;
  readonly remoteRoot?: string;
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
  if (opts.remoteRoot) {
    await run({
      cwd: root,
      cmd: ["git", "remote", "add", "origin", opts.remoteRoot],
    });
  }
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
