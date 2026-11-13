import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
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

// Source CLI: isolated HOME/state and substituted resolver transport. Optional
// compiled qualification observes the platform's actual DNS diagnostics.
const compiledCli = process.env.HACK_NAME_TEST_BINARY
  ? resolve(process.env.HACK_NAME_TEST_BINARY)
  : null;
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
  const preload = resolve(fixture.root, "resolver-preload.ts");
  const shellPath = resolve(import.meta.dir, "../src/lib/shell.ts");
  // Source CLI tests must not depend on the host's resolver or Docker. This
  // boundary also catches macOS's absolute /usr/bin/dscacheutil invocation.
  await writeFile(
    preload,
    `import { mock } from "bun:test";
const shell = { ...await import(${JSON.stringify(shellPath)}) };
const execute = shell.exec;
mock.module(${JSON.stringify(shellPath)}, () => ({
  ...shell,
  exec: async (command, options) => {
    if (command[0] === "getent" || command[0] === "/usr/bin/dscacheutil") {
      return {
        exitCode: 0,
        stdout: command[0] === "getent"
          ? "192.0.2.10 STREAM fixture\\n"
          : "name: fixture\\nip_address: 192.0.2.10\\n",
        stderr: "",
      };
    }
    if (command[0] === "docker") {
      throw new Error("Local Network hint fixture must not read real Docker");
    }
    return execute(command, options);
  },
}));
`
  );
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
    [
      ...(compiledCli
        ? [compiledCli]
        : [
            process.execPath,
            "--preload",
            preload,
            resolve(import.meta.dir, "../index.ts"),
          ]),
      "open",
      "--json",
      "--prefer",
      "dev",
      "--project",
      "my-app",
    ],
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

/** Compiled qualification may include the platform's separate DNS notice. */
function expectUrlPayload(stdout: string, url: string): void {
  const payload: unknown = JSON.parse(stdout);
  if (compiledCli && isRecord(payload) && "dns" in payload) {
    expect(payload.dns === "unresolved" || payload.dns === "unconfigured").toBe(
      true
    );
    expect(payload).toEqual({
      url,
      dns: payload.dns,
      hint: expect.any(String),
    });
  } else {
    // The source fixture resolves positively to a non-loopback documentation IP.
    expect(payload).toEqual({ url });
  }
  expect(stdout).not.toContain("Local Network");
}

test("open --json keeps the Local Network permission hint out of the JSON payload", async () => {
  const result = await openJson(null);
  expect(result.code, result.stderr).toBe(0);
  expectUrlPayload(result.stdout, "https://name-fixture.hack.local");
  // Shown once on macOS, never elsewhere.
  expect(countHints(result.stderr)).toBe(process.platform === "darwin" ? 1 : 0);
}, 15_000);

test("open --json does not hint for a non-.local host", async () => {
  const result = await openJson("name-fixture.hack.gy");
  expect(result.code, result.stderr).toBe(0);
  expectUrlPayload(result.stdout, "https://name-fixture.hack.gy");
  expect(countHints(result.stderr)).toBe(0);
}, 15_000);
