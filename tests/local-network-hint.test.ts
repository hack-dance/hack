import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  browserHostFromTarget,
  createLocalNetworkHintEmitter,
  isLocalSuffixTarget,
  LOCAL_NETWORK_HINT_MESSAGE,
  shouldShowLocalNetworkHint,
} from "../src/lib/local-network-hint.ts";
import { projectNameFixture } from "./helpers/project-name-fixture.ts";

function capture(platform: string) {
  const lines: string[] = [];
  const emitter = createLocalNetworkHintEmitter({
    platform,
    write: (line) => {
      lines.push(line);
    },
  });
  return { emitter, lines };
}

test("hint appears for .local URLs and hosts on macOS", () => {
  for (const target of [
    "https://my-app.hack.local",
    "https://api.my-app.hack.local/",
    "https://MY-APP.HACK.LOCAL",
    "my-app.hack.local",
    "my-app.hack.local.",
    "https://my-app.hack.local:8443",
    "hack.local",
  ]) {
    const { emitter, lines } = capture("darwin");
    expect(emitter.note([target]), target).toBe(true);
    expect(lines).toEqual([`${LOCAL_NETWORK_HINT_MESSAGE}\n`]);
  }
});

test("hint is not shown for non-.local hosts", () => {
  for (const target of [
    "https://my-app.hack",
    "https://my-app.hack.gy",
    "https://my-app.hack.local.gy",
    "https://localhost:3000",
    "https://app.localhost",
    "https://notlocal",
    "https://127.0.0.1",
    "https://dev.example.com",
    "",
    "   ",
    "not a url at all ::",
  ]) {
    const { emitter, lines } = capture("darwin");
    expect(emitter.note([target]), target).toBe(false);
    expect(lines).toEqual([]);
  }
});

test("hint is never shown on other platforms", () => {
  for (const platform of ["linux", "win32", "freebsd"]) {
    const { emitter, lines } = capture(platform);
    expect(emitter.note(["https://my-app.hack.local"])).toBe(false);
    expect(lines).toEqual([]);
    expect(
      shouldShowLocalNetworkHint({
        platform,
        targets: ["https://my-app.hack.local"],
      })
    ).toBe(false);
  }
});

test("hint is shown at most once per emitter", () => {
  const { emitter, lines } = capture("darwin");
  expect(emitter.note(["https://my-app.hack.gy"])).toBe(false);
  expect(emitter.note(["https://a.hack.local", "https://b.hack.local"])).toBe(
    true
  );
  expect(emitter.note(["https://c.hack.local"])).toBe(false);
  expect(lines).toHaveLength(1);
});

test("hint text is closed: one line, no interpolated host", () => {
  const { emitter, lines } = capture("darwin");
  emitter.note(["https://secret-project-name.hack.local"]);
  expect(lines.join("")).not.toContain("secret-project-name");
  expect(LOCAL_NETWORK_HINT_MESSAGE).not.toContain("\n");
  expect(LOCAL_NETWORK_HINT_MESSAGE).toContain("Safari");
  expect(LOCAL_NETWORK_HINT_MESSAGE).toContain(
    "System Settings > Privacy & Security > Local Network"
  );
});

test("host extraction normalizes case and the root dot", () => {
  expect(browserHostFromTarget("https://API.App.Hack.Local./x")).toBe(
    "api.app.hack.local"
  );
  expect(browserHostFromTarget("")).toBeNull();
  expect(isLocalSuffixTarget("https://app.hack.local")).toBe(true);
  expect(isLocalSuffixTarget("https://app.local.example.com")).toBe(false);
});

// Real CLI boundary: isolated HOME/state, no daemon, no Docker.
const cli = process.env.HACK_NAME_TEST_BINARY
  ? [resolve(process.env.HACK_NAME_TEST_BINARY)]
  : [process.execPath, resolve(import.meta.dir, "../index.ts")];
let cleanupRoot: string | null = null;

afterEach(async () => {
  if (cleanupRoot) {
    await rm(cleanupRoot, { recursive: true, force: true });
    cleanupRoot = null;
  }
});

async function openJson(devHost: string | null) {
  const fixture = await projectNameFixture();
  cleanupRoot = fixture.root;
  const target = await fixture.createProject("app", "my-app");
  if (devHost) {
    await writeFile(
      target.project.configFile,
      JSON.stringify({ name: "my-app", dev_host: devHost })
    );
  }
  await fixture.writeRegistry([
    devHost ? { ...target.entry, devHost } : target.entry,
  ]);
  const child = Bun.spawn(
    [...cli, "open", "--json", "--prefer", "dev", "--project", "my-app"],
    {
      cwd: fixture.root,
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function countHints(text: string): number {
  return text.split(LOCAL_NETWORK_HINT_MESSAGE).length - 1;
}

test("open --json keeps the hint out of the JSON payload", async () => {
  const result = await openJson(null);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    url: "https://name-fixture.hack.local",
  });
  expect(result.stdout).not.toContain("Local Network");
  // Shown once on macOS, never elsewhere.
  expect(countHints(result.stderr)).toBe(process.platform === "darwin" ? 1 : 0);
}, 15_000);

test("open --json does not hint for a non-.local host", async () => {
  const result = await openJson("name-fixture.hack.gy");
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    url: "https://name-fixture.hack.gy",
  });
  expect(countHints(result.stderr)).toBe(0);
}, 15_000);
