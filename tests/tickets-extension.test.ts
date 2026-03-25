import { afterEach, beforeEach, expect } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createTicketsStore } from "../src/control-plane/extensions/tickets/store.ts";
import { readControlPlaneConfig } from "../src/control-plane/sdk/config.ts";
import { testIntegration } from "./helpers/ci.ts";

const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;

beforeEach(() => {
  process.env.HACK_GLOBAL_CONFIG_PATH = join(
    tmpdir(),
    `hack-global-config-${Date.now()}-${Math.random()}.json`
  );
});

afterEach(() => {
  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
});

testIntegration(
  "tickets extension: create/list/show with isolated git ref stays local-first when broker auth is unavailable",
  { timeout: 60_000 },
  async () => {
    const previousAuthBrokerUrl = process.env.HACK_AUTH_BROKER_URL;
    process.env.HACK_AUTH_BROKER_URL = "http://127.0.0.1:9";

    const root = await mkdirTempDir({ prefix: "hack-cli-tickets-e2e-" });
    const projectDir = join(root, "project");
    const remoteDir = join(root, "remote.git");
    try {
      await mkdir(projectDir, { recursive: true });
      await copyDir({
        from: resolve(import.meta.dir, "../examples/tickets"),
        to: projectDir,
      });

      await run({ cwd: projectDir, cmd: ["git", "init"] });
      await run({
        cwd: projectDir,
        cmd: ["git", "config", "user.email", "tests@hack"],
      });
      await run({
        cwd: projectDir,
        cmd: ["git", "config", "user.name", "hack-cli-tests"],
      });
      await run({ cwd: projectDir, cmd: ["git", "add", "-A"] });
      await run({ cwd: projectDir, cmd: ["git", "commit", "-m", "init"] });

      await run({ cwd: root, cmd: ["git", "init", "--bare", remoteDir] });
      await run({
        cwd: projectDir,
        cmd: ["git", "remote", "add", "origin", remoteDir],
      });
      await run({
        cwd: projectDir,
        cmd: ["git", "push", "-u", "origin", "HEAD:main"],
      });

      const beforeHead = (
        await run({
          cwd: projectDir,
          cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        })
      ).stdout.trim();

      const created = await runHack({
        cwd: projectDir,
        args: ["tickets", "create", "--title", "First ticket", "--json"],
      });
      const createdJson = JSON.parse(created.stdout) as {
        ticket: { ticketId: string };
      };
      expect(createdJson.ticket.ticketId).toMatch(/^T-[0-9A-Z]{10}$/);

      const updated = await runHack({
        cwd: projectDir,
        args: [
          "tickets",
          "update",
          createdJson.ticket.ticketId,
          "--title",
          "Updated ticket title",
          "--json",
        ],
      });
      const updatedJson = JSON.parse(updated.stdout) as { ok: boolean };
      expect(updatedJson.ok).toBe(true);

      const status = await runHack({
        cwd: projectDir,
        args: [
          "tickets",
          "status",
          createdJson.ticket.ticketId,
          "in_progress",
          "--json",
        ],
      });
      const statusJson = JSON.parse(status.stdout) as { ok: boolean };
      expect(statusJson.ok).toBe(true);

      const afterHead = (
        await run({
          cwd: projectDir,
          cmd: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        })
      ).stdout.trim();
      expect(afterHead).toBe(beforeHead);

      const listed = await runHack({
        cwd: projectDir,
        args: ["tickets", "list", "--json"],
      });
      const listJson = JSON.parse(listed.stdout) as {
        tickets: { ticketId: string; title: string; status: string }[];
      };
      expect(listJson.tickets.length).toBe(1);
      expect(listJson.tickets[0]?.title).toBe("Updated ticket title");
      expect(listJson.tickets[0]?.status).toBe("in_progress");

      const shown = await runHack({
        cwd: projectDir,
        args: ["tickets", "show", createdJson.ticket.ticketId, "--json"],
      });
      const showJson = JSON.parse(shown.stdout) as {
        ticket: { ticketId: string; title: string; status: string };
        events: { type: string }[];
      };
      expect(showJson.ticket.ticketId).toBe(createdJson.ticket.ticketId);
      expect(showJson.ticket.title).toBe("Updated ticket title");
      expect(showJson.ticket.status).toBe("in_progress");
      expect(showJson.events.some((e) => e.type === "ticket.created")).toBe(
        true
      );

      const showRef = await runAllowFail({
        cwd: root,
        cmd: [
          "git",
          `--git-dir=${remoteDir}`,
          "show-ref",
          "--verify",
          "refs/hack/tickets",
        ],
      });
      expect(showRef.exitCode).toBe(0);
    } finally {
      if (previousAuthBrokerUrl === undefined) {
        Reflect.deleteProperty(process.env, "HACK_AUTH_BROKER_URL");
      } else {
        process.env.HACK_AUTH_BROKER_URL = previousAuthBrokerUrl;
      }

      await rm(root, { recursive: true, force: true });
    }
  }
);

testIntegration(
  "tickets extension: assignee, review note, comment, and conflict resolution commands work end to end",
  { timeout: 60_000 },
  async () => {
    const root = await mkdirTempDir({ prefix: "hack-cli-tickets-sync-e2e-" });
    const projectDir = join(root, "project");

    await mkdir(projectDir, { recursive: true });
    await copyDir({
      from: resolve(import.meta.dir, "../examples/tickets"),
      to: projectDir,
    });

    await run({ cwd: projectDir, cmd: ["git", "init"] });
    await run({
      cwd: projectDir,
      cmd: ["git", "config", "user.email", "tests@hack"],
    });
    await run({
      cwd: projectDir,
      cmd: ["git", "config", "user.name", "hack-cli-tests"],
    });
    await run({ cwd: projectDir, cmd: ["git", "add", "-A"] });
    await run({ cwd: projectDir, cmd: ["git", "commit", "-m", "init"] });

    const created = await runHack({
      cwd: projectDir,
      args: [
        "tickets",
        "create",
        "--title",
        "Sync lifecycle ticket",
        "--assignee",
        "alice@hack",
        "--json",
      ],
    });
    const createdJson = JSON.parse(created.stdout) as {
      ticket: { ticketId: string };
    };
    const ticketId = createdJson.ticket.ticketId;

    const commented = await runHack({
      cwd: projectDir,
      args: [
        "tickets",
        "comment",
        ticketId,
        "--body",
        "Append only note",
        "--source",
        "hack",
        "--json",
      ],
    });
    const commentJson = JSON.parse(commented.stdout) as {
      comment: { body: string; source: string };
    };
    expect(commentJson.comment.body).toBe("Append only note");
    expect(commentJson.comment.source).toBe("hack");

    const reviewed = await runHack({
      cwd: projectDir,
      args: [
        "tickets",
        "review-note",
        ticketId,
        "--body",
        "Shared review note",
        "--json",
      ],
    });
    const reviewJson = JSON.parse(reviewed.stdout) as {
      reviewNote: { body: string };
    };
    expect(reviewJson.reviewNote.body).toBe("Shared review note");

    const store = await createStore({ projectRoot: projectDir });
    const conflict = await store.recordSyncConflict({
      ticketId,
      provider: "linear",
      field: "title",
      authority: "origin",
      localValue: "Local title",
      remoteValue: "Remote title",
      summary: "Title diverged during sync.",
      actor: "sync@app",
    });
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) {
      throw new Error(conflict.error);
    }

    const resolved = await runHack({
      cwd: projectDir,
      args: [
        "tickets",
        "resolve-conflict",
        ticketId,
        "--conflict-id",
        conflict.conflict.conflictId,
        "--resolution",
        "accept_remote",
        "--summary",
        "Remote remains authoritative.",
        "--json",
      ],
    });
    const resolvedJson = JSON.parse(resolved.stdout) as {
      ok: boolean;
      resolution: string;
    };
    expect(resolvedJson.ok).toBe(true);
    expect(resolvedJson.resolution).toBe("accept_remote");

    const shown = await runHack({
      cwd: projectDir,
      args: ["tickets", "show", ticketId, "--json"],
    });
    const showJson = JSON.parse(shown.stdout) as {
      ticket: { assignee?: string };
      comments: Array<{ body: string }>;
      reviewNotes: Array<{ body: string }>;
      conflicts: Array<{ status: string; resolution?: string }>;
    };
    expect(showJson.ticket.assignee).toBe("alice@hack");
    expect(showJson.comments.map((comment) => comment.body)).toContain(
      "Append only note"
    );
    expect(showJson.reviewNotes.map((reviewNote) => reviewNote.body)).toContain(
      "Shared review note"
    );
    expect(showJson.conflicts[0]?.status).toBe("resolved");
    expect(showJson.conflicts[0]?.resolution).toBe("accept_remote");

    await rm(root, { recursive: true, force: true });
  }
);

testIntegration(
  "tickets extension: cli rebuilds sqlite projection after local deletion",
  { timeout: 60_000 },
  async () => {
    const root = await mkdirTempDir({
      prefix: "hack-cli-tickets-projection-e2e-",
    });
    const projectDir = join(root, "project");

    await mkdir(projectDir, { recursive: true });
    await copyDir({
      from: resolve(import.meta.dir, "../examples/tickets"),
      to: projectDir,
    });

    await run({ cwd: projectDir, cmd: ["git", "init"] });
    await run({
      cwd: projectDir,
      cmd: ["git", "config", "user.email", "tests@hack"],
    });
    await run({
      cwd: projectDir,
      cmd: ["git", "config", "user.name", "hack-cli-tests"],
    });
    await run({ cwd: projectDir, cmd: ["git", "add", "-A"] });
    await run({ cwd: projectDir, cmd: ["git", "commit", "-m", "init"] });

    const created = await runHack({
      cwd: projectDir,
      args: ["tickets", "create", "--title", "Projection lifecycle", "--json"],
    });
    const createdJson = JSON.parse(created.stdout) as {
      ticket: { ticketId: string };
    };

    const projectionPath = join(projectDir, ".hack/tickets/projection.sqlite");
    expect(await Bun.file(projectionPath).exists()).toBe(true);

    await rm(projectionPath, { force: true });
    expect(await Bun.file(projectionPath).exists()).toBe(false);

    const shown = await runHack({
      cwd: projectDir,
      args: ["tickets", "show", createdJson.ticket.ticketId, "--json"],
    });
    expect(shown.exitCode).toBe(0);
    expect(await Bun.file(projectionPath).exists()).toBe(true);

    await rm(root, { recursive: true, force: true });
  }
);

testIntegration(
  "tickets extension: document command appends spec docs and updates the active description",
  { timeout: 60_000 },
  async () => {
    const root = await mkdirTempDir({ prefix: "hack-cli-tickets-docs-e2e-" });
    const projectDir = join(root, "project");

    await mkdir(projectDir, { recursive: true });
    await copyDir({
      from: resolve(import.meta.dir, "../examples/tickets"),
      to: projectDir,
    });

    await run({ cwd: projectDir, cmd: ["git", "init"] });
    await run({
      cwd: projectDir,
      cmd: ["git", "config", "user.email", "tests@hack"],
    });
    await run({
      cwd: projectDir,
      cmd: ["git", "config", "user.name", "hack-cli-tests"],
    });
    await run({ cwd: projectDir, cmd: ["git", "add", "-A"] });
    await run({ cwd: projectDir, cmd: ["git", "commit", "-m", "init"] });

    const created = await runHack({
      cwd: projectDir,
      args: [
        "tickets",
        "create",
        "--title",
        "Document lifecycle",
        "--body",
        "## Context\nInitial description",
        "--json",
      ],
    });
    const createdJson = JSON.parse(created.stdout) as {
      ticket: { ticketId: string };
    };
    const ticketId = createdJson.ticket.ticketId;

    const spec = await runHack({
      cwd: projectDir,
      args: [
        "tickets",
        "document",
        ticketId,
        "--kind",
        "spec",
        "--body",
        "## Goals\n- Add spec support",
        "--json",
      ],
    });
    const specJson = JSON.parse(spec.stdout) as {
      document: { kind: string; role: string };
    };
    expect(specJson.document.kind).toBe("spec");
    expect(specJson.document.role).toBe("spec");

    const description = await runHack({
      cwd: projectDir,
      args: [
        "tickets",
        "document",
        ticketId,
        "--kind",
        "description",
        "--body",
        "## Context\nUpdated description",
        "--json",
      ],
    });
    const descriptionJson = JSON.parse(description.stdout) as {
      document: { kind: string; content: string };
    };
    expect(descriptionJson.document.kind).toBe("description");
    expect(descriptionJson.document.content).toBe(
      "## Context\nUpdated description"
    );

    const shown = await runHack({
      cwd: projectDir,
      args: ["tickets", "show", ticketId, "--json"],
    });
    const showJson = JSON.parse(shown.stdout) as {
      ticket: { body?: string };
      documents: Array<{ kind: string; role: string; content: string }>;
    };
    expect(showJson.ticket.body).toBe("## Context\nUpdated description");
    expect(showJson.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "description",
          role: "description",
          content: "## Context\nInitial description",
        }),
        expect.objectContaining({
          kind: "spec",
          role: "spec",
          content: "## Goals\n- Add spec support",
        }),
        expect.objectContaining({
          kind: "description",
          role: "description",
          content: "## Context\nUpdated description",
        }),
      ])
    );

    await rm(root, { recursive: true, force: true });
  }
);

testIntegration(
  "tickets extension: hidden ref sync transports only the journal and peers rebuild projection state locally",
  { timeout: 60_000 },
  async () => {
    const root = await mkdirTempDir({
      prefix: "hack-cli-tickets-portability-e2e-",
    });
    const authorDir = join(root, "author");
    const peerDir = join(root, "peer");
    const remoteDir = join(root, "remote.git");

    await mkdir(authorDir, { recursive: true });
    await copyDir({
      from: resolve(import.meta.dir, "../examples/tickets"),
      to: authorDir,
    });

    await run({ cwd: authorDir, cmd: ["git", "init"] });
    await run({
      cwd: authorDir,
      cmd: ["git", "config", "user.email", "tests@hack"],
    });
    await run({
      cwd: authorDir,
      cmd: ["git", "config", "user.name", "hack-cli-tests"],
    });
    await run({ cwd: authorDir, cmd: ["git", "add", "-A"] });
    await run({ cwd: authorDir, cmd: ["git", "commit", "-m", "init"] });

    await run({ cwd: root, cmd: ["git", "init", "--bare", remoteDir] });
    await run({
      cwd: authorDir,
      cmd: ["git", "remote", "add", "origin", remoteDir],
    });
    await run({
      cwd: authorDir,
      cmd: ["git", "push", "-u", "origin", "HEAD:main"],
    });

    const created = await runHack({
      cwd: authorDir,
      args: ["tickets", "create", "--title", "Portable journal", "--json"],
    });
    const createdJson = JSON.parse(created.stdout) as {
      ticket: { ticketId: string };
    };

    const remoteTree = await run({
      cwd: root,
      cmd: [
        "git",
        `--git-dir=${remoteDir}`,
        "ls-tree",
        "-r",
        "--name-only",
        "refs/hack/tickets",
      ],
    });
    const remotePaths = remoteTree.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(
      remotePaths.some((path) =>
        path.startsWith(".hack/tickets/events/events-")
      )
    ).toBe(true);
    expect(remotePaths).not.toContain(".hack/tickets/projection.sqlite");

    await mkdir(peerDir, { recursive: true });
    await copyDir({
      from: resolve(import.meta.dir, "../examples/tickets"),
      to: peerDir,
    });
    await run({ cwd: peerDir, cmd: ["git", "init"] });
    await run({
      cwd: peerDir,
      cmd: ["git", "config", "user.email", "tests@hack"],
    });
    await run({
      cwd: peerDir,
      cmd: ["git", "config", "user.name", "hack-cli-tests"],
    });
    await run({ cwd: peerDir, cmd: ["git", "add", "-A"] });
    await run({ cwd: peerDir, cmd: ["git", "commit", "-m", "init"] });
    await run({
      cwd: peerDir,
      cmd: ["git", "remote", "add", "origin", remoteDir],
    });

    const synced = await runHack({
      cwd: peerDir,
      args: ["tickets", "sync", "--json"],
    });
    expect(synced.exitCode).toBe(0);

    const shown = await runHack({
      cwd: peerDir,
      args: ["tickets", "show", createdJson.ticket.ticketId, "--json"],
    });
    expect(shown.exitCode).toBe(0);

    const eventsDir = join(
      peerDir,
      ".hack/tickets/git/worktree/.hack/tickets/events"
    );
    const eventFiles = (await readdir(eventsDir))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort();
    expect(eventFiles.length).toBeGreaterThan(0);
    const journalBeforeDeletion = await readFile(
      join(eventsDir, eventFiles[0] ?? ""),
      "utf8"
    );

    const projectionPath = join(peerDir, ".hack/tickets/projection.sqlite");
    expect(await Bun.file(projectionPath).exists()).toBe(true);
    await rm(projectionPath, { force: true });
    expect(await Bun.file(projectionPath).exists()).toBe(false);

    const rebuilt = await runHack({
      cwd: peerDir,
      args: ["tickets", "list", "--json"],
    });
    expect(rebuilt.exitCode).toBe(0);
    expect(await Bun.file(projectionPath).exists()).toBe(true);

    const journalAfterDeletion = await readFile(
      join(eventsDir, eventFiles[0] ?? ""),
      "utf8"
    );
    expect(journalAfterDeletion).toBe(journalBeforeDeletion);

    await rm(root, { recursive: true, force: true });
  }
);

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function run(opts: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}): Promise<RunResult> {
  const result = await runAllowFail(opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${opts.cmd.join(" ")}\n${result.stderr || result.stdout}`
    );
  }
  return result;
}

async function runAllowFail(opts: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}): Promise<RunResult> {
  const proc = Bun.spawn([...opts.cmd], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      HOME: homedir(),
    },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function runHack(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<RunResult> {
  return await run({
    cwd: opts.cwd,
    cmd: ["bun", resolve(import.meta.dir, "../index.ts"), ...opts.args],
  });
}

async function createStore(opts: { readonly projectRoot: string }) {
  const result = await readControlPlaneConfig({});
  return createTicketsStore({
    projectRoot: opts.projectRoot,
    controlPlaneConfig: result.config,
    logger: {
      info: () => {},
      warn: () => {},
    },
  });
}

async function mkdirTempDir(opts: {
  readonly prefix: string;
}): Promise<string> {
  const root = join(tmpdir(), `${opts.prefix}${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  return root;
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
