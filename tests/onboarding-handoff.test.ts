import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type OnboardingAgent,
  parseOnboardingWith,
  resolveOnboardingAgents,
  runOnboardingHandoff,
} from "../src/agents/onboarding-handoff.ts";

let tempDir: string | null = null;
let originalPath: string | undefined;
let capturedStdout = "";
let originalStdoutWrite: typeof process.stdout.write;

beforeEach(() => {
  originalPath = process.env.PATH;
  capturedStdout = "";
  originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    capturedStdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  if (originalPath === undefined) {
    Reflect.deleteProperty(process.env, "PATH");
  } else {
    process.env.PATH = originalPath;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function setupStubPath(opts: {
  readonly binaries: readonly string[];
}): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-onboarding-"));
  for (const name of opts.binaries) {
    const binPath = join(tempDir, name);
    await writeFile(binPath, "#!/bin/sh\nexit 0\n");
    await chmod(binPath, 0o755);
  }
  process.env.PATH = tempDir;
  return tempDir;
}

test("parseOnboardingWith accepts claude and codex (case/space tolerant)", () => {
  expect(parseOnboardingWith({ value: "claude" })).toBe("claude");
  expect(parseOnboardingWith({ value: "codex" })).toBe("codex");
  expect(parseOnboardingWith({ value: "both" })).toBeNull();
  expect(parseOnboardingWith({ value: " Claude " })).toBe("claude");
});

test("parseOnboardingWith rejects unknown values", () => {
  expect(parseOnboardingWith({ value: "cursor" })).toBeNull();
  expect(parseOnboardingWith({ value: "" })).toBeNull();
  expect(parseOnboardingWith({ value: "claude,codex" })).toBeNull();
});

test("resolveOnboardingAgents selects exactly one client", () => {
  expect(resolveOnboardingAgents({ withValue: "claude" })).toEqual(["claude"]);
  expect(resolveOnboardingAgents({ withValue: "codex" })).toEqual(["codex"]);
});

test("non-interactive runs never spawn and print the prompt", async () => {
  await setupStubPath({ binaries: ["claude", "codex"] });
  const launches: string[] = [];

  const outcome = await runOnboardingHandoff({
    prompt: "PROMPT-BODY",
    withValue: "claude",
    interactive: false,
    launch: ({ agent }) => {
      launches.push(agent);
      return Promise.resolve(0);
    },
  });

  expect(launches).toEqual([]);
  expect(outcome.launched).toEqual([]);
  expect(outcome.printed).toBe(true);
  expect(capturedStdout).toContain("PROMPT-BODY");
  expect(capturedStdout).toContain("non-interactive run");
});

test("missing binaries fall back to printing the prompt with instructions", async () => {
  await setupStubPath({ binaries: [] });

  const outcome = await runOnboardingHandoff({
    prompt: "PROMPT-BODY",
    withValue: "claude",
    interactive: true,
    launch: () => Promise.resolve(0),
  });

  expect(outcome.launched).toEqual([]);
  expect(outcome.missing).toEqual(["claude"]);
  expect(outcome.printed).toBe(true);
  expect(capturedStdout).toContain("PROMPT-BODY");
  expect(capturedStdout).toContain("claude");
  expect(capturedStdout).toContain("not found on PATH");
});

test("available binaries are launched with the prompt as positional argument", async () => {
  const stubDir = await setupStubPath({ binaries: ["claude", "codex"] });
  const launches: Array<{
    agent: OnboardingAgent;
    binPath: string;
    prompt: string;
  }> = [];

  const outcome = await runOnboardingHandoff({
    prompt: "PROMPT-BODY",
    withValue: "claude",
    interactive: true,
    launch: (opts) => {
      launches.push(opts);
      return Promise.resolve(0);
    },
  });

  expect(outcome.launched).toEqual(["claude"]);
  expect(outcome.missing).toEqual([]);
  expect(outcome.printed).toBe(false);
  expect(launches).toHaveLength(1);
  expect(launches[0]?.agent).toBe("claude");
  expect(launches[0]?.binPath).toBe(join(stubDir, "claude"));
  expect(launches[0]?.prompt).toBe("PROMPT-BODY");
  expect(capturedStdout).not.toContain("PROMPT-BODY");
});

test("missing selected agent does not launch a different installed client", async () => {
  await setupStubPath({ binaries: ["codex"] });
  const launches: string[] = [];

  const outcome = await runOnboardingHandoff({
    prompt: "PROMPT-BODY",
    withValue: "claude",
    interactive: true,
    launch: ({ agent }) => {
      launches.push(agent);
      return Promise.resolve(0);
    },
  });

  expect(launches).toEqual([]);
  expect(outcome.launched).toEqual([]);
  expect(outcome.missing).toEqual(["claude"]);
  expect(outcome.printed).toBe(true);
  expect(capturedStdout).toContain("PROMPT-BODY");
});
