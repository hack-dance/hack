import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/run.ts";
import {
  compareUpdateVersions,
  observeUpdate,
  parseUpdateVersion,
} from "../src/lib/update-observe.ts";
import { machineError } from "./helpers/machine-output.ts";

/** No real network: every case supplies the releases response it expects. */
function releases(opts: {
  readonly latest?: unknown;
  readonly list?: unknown;
  readonly status?: number;
  readonly fail?: boolean;
}) {
  const urls: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (opts.fail) {
      throw new TypeError("network down");
    }
    const body = url.endsWith("/latest") ? opts.latest : opts.list;
    return new Response(JSON.stringify(body ?? null), {
      status: opts.status ?? 200,
    });
  }) as typeof fetch;
  return { fetch: fake, urls };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-update-observe-"));
});
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

async function executable(relative: string): Promise<string> {
  const path = join(root, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "\x7fELF placeholder", { mode: 0o755 });
  return path;
}

const base = { env: {}, homeDir: "/example/user" } as const;

test("candidate versions sort before their release and by next number", () => {
  const parse = (raw: string) => {
    const parsed = parseUpdateVersion(raw);
    if (!parsed) {
      throw new Error(raw);
    }
    return parsed;
  };
  expect(
    compareUpdateVersions(parse("5.0.0-next.17"), parse("5.0.0-next.18"))
  ).toBe(-1);
  expect(compareUpdateVersions(parse("5.0.0-next.18"), parse("5.0.0"))).toBe(
    -1
  );
  expect(compareUpdateVersions(parse("v5.0.1"), parse("5.0.0"))).toBe(1);
  expect(compareUpdateVersions(parse("5.0.0"), parse("v5.0.0"))).toBe(0);
  expect(parseUpdateVersion("5.0.0-rc.1")).toBeNull();
  expect(parseUpdateVersion("not a version")).toBeNull();
});

test("a stable standalone install reads the latest release and offers its own update", async () => {
  const binary = await executable("bin/hack");
  const read = releases({ latest: { tag_name: "v4.4.0", draft: false } });
  const report = await observeUpdate({
    ...base,
    version: "4.3.0",
    executable: binary,
    compiled: true,
    fetch: read.fetch,
  });
  expect(report).toEqual({
    current: "4.3.0",
    channel: "stable",
    latest: "4.4.0",
    available: true,
    install_kind: "standalone",
    upgrade_command: [binary, "update"],
    reason: null,
  });
  expect(read.urls).toEqual([
    "https://api.github.com/repos/hack-dance/hack/releases/latest",
  ]);
});

test("a Homebrew install is reported, not refused, with the brew upgrade", async () => {
  const binary = await executable("opt/homebrew/Cellar/hack/4.3.0/bin/hack");
  const report = await observeUpdate({
    ...base,
    version: "4.3.0",
    executable: binary,
    compiled: true,
    fetch: releases({ latest: { tag_name: "v4.4.0" } }).fetch,
  });
  expect(report.install_kind).toBe("homebrew");
  expect(report.available).toBe(true);
  expect(report.upgrade_command).toEqual([
    "brew",
    "upgrade",
    "hack-dance/tap/hack",
  ]);
});

test("a candidate picks the newest same-major next release and its manager upgrade", async () => {
  const read = releases({
    list: [
      { tag_name: "v5.0.0-next.18", draft: false, prerelease: true },
      { tag_name: "v5.0.0-next.20", draft: true, prerelease: true },
      { tag_name: "v5.0.0-next.19", draft: false, prerelease: true },
      { tag_name: "v6.0.0-next.1", draft: false, prerelease: true },
      { tag_name: "v4.4.0", draft: false, prerelease: false },
      { tag_name: "nightly", draft: false },
      "not a release",
    ],
  });
  const report = await observeUpdate({
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-next" },
    homeDir: "/example/user",
    version: "5.0.0-next.17",
    executable: "/example/bun",
    compiled: false,
    fetch: read.fetch,
  });
  expect(report).toEqual({
    current: "5.0.0-next.17",
    channel: "next",
    latest: "5.0.0-next.19",
    available: true,
    install_kind: "candidate",
    upgrade_command: [
      "/example/user/.hack-next/bin/hack-next",
      "--manager",
      "upgrade",
      "--version",
      "5.0.0-next.19",
    ],
    reason: null,
  });
  expect(read.urls).toEqual([
    "https://api.github.com/repos/hack-dance/hack/releases?per_page=100",
  ]);
});

test("no supported path or no update gives no command", async () => {
  const source = await observeUpdate({
    ...base,
    version: "4.3.0",
    executable: "/example/bun",
    compiled: false,
    fetch: releases({ latest: { tag_name: "v4.4.0" } }).fetch,
  });
  expect(source.install_kind).toBe("source");
  expect(source.available).toBe(true);
  expect(source.upgrade_command).toBeNull();

  const current = await observeUpdate({
    ...base,
    version: "4.4.0",
    executable: await executable("bin/hack"),
    compiled: true,
    fetch: releases({ latest: { tag_name: "v4.4.0" } }).fetch,
  });
  expect(current.available).toBe(false);
  expect(current.upgrade_command).toBeNull();
  expect(current.reason).toBeNull();
});

test("missing evidence is unknown with a closed reason, never up to date", async () => {
  const offline = await observeUpdate({
    ...base,
    version: "4.3.0",
    executable: "/example/bun",
    compiled: false,
    fetch: releases({ fail: true }).fetch,
  });
  expect(offline).toMatchObject({
    latest: null,
    available: null,
    upgrade_command: null,
    reason: "network-unavailable",
  });
  for (const response of [
    { status: 404, latest: { message: "Not Found" } },
    { latest: { tag_name: "v4.4.0-rc.1" } },
    { latest: { tag_name: "v4.4.0", draft: true } },
  ]) {
    const report = await observeUpdate({
      ...base,
      version: "4.3.0",
      executable: "/example/bun",
      compiled: false,
      fetch: releases(response).fetch,
    });
    expect(report.reason).toBe("release-unavailable");
    expect(report.available).toBeNull();
  }
  const noCandidates = await observeUpdate({
    ...base,
    version: "5.0.0-next.17",
    executable: "/example/bun",
    compiled: false,
    fetch: releases({ list: [{ tag_name: "v4.4.0" }] }).fetch,
  });
  expect(noCandidates.reason).toBe("release-unavailable");
});

test("an unsupported prerelease channel is unknown without any network read", async () => {
  const read = releases({ latest: { tag_name: "v5.0.0" } });
  const report = await observeUpdate({
    ...base,
    version: "5.0.0-rc.1",
    executable: "/example/bun",
    compiled: false,
    fetch: read.fetch,
  });
  expect(report).toMatchObject({
    channel: "prerelease",
    available: null,
    reason: "version-unrecognized",
  });
  expect(read.urls).toEqual([]);
});

async function cli(args: readonly string[]) {
  let stdout = "";
  spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  spyOn(process.stderr, "write").mockReturnValue(true);
  const spawn = spyOn(Bun, "spawn");
  const spawnSync = spyOn(Bun, "spawnSync");
  const code = await runCli([...args]);
  return { code, stdout, spawn, spawnSync };
}

test("the CLI prints the schema envelope, refusing nothing and starting nothing", async () => {
  const read = releases({ latest: { tag_name: "v99.0.0" } });
  spyOn(globalThis, "fetch").mockImplementation(read.fetch as never);
  const saved = process.env.HACK_CANDIDATE_ENTRYPOINT;
  Reflect.deleteProperty(process.env, "HACK_CANDIDATE_ENTRYPOINT");
  try {
    const run = await cli(["update", "--check", "--json", "--observe"]);
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(Object.keys(result).sort()).toEqual(["data", "ok"]);
    expect(result.ok).toBe(true);
    expect(result.data.schema).toBe("hack.update-check.v1");
    expect(Object.keys(result.data).sort()).toEqual([
      "available",
      "channel",
      "current",
      "install_kind",
      "latest",
      "reason",
      "schema",
      "upgrade_command",
    ]);
    expect(result.data.latest).toBe("99.0.0");
    expect(read.urls).toHaveLength(1);
    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.spawnSync).not.toHaveBeenCalled();
  } finally {
    if (saved !== undefined) {
      process.env.HACK_CANDIDATE_ENTRYPOINT = saved;
    }
  }
});

test.each([
  [["update", "--observe", "--json"]],
  [["update", "--check", "--observe", "--json", "--yes"]],
  [["update", "--check", "--observe", "--json", "--tag", "v1.0.0"]],
])("%p is a usage error before any network read", async (args) => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
    throw new Error("unexpected network read");
  }) as never);
  const run = await cli(args);
  expect(run.code).not.toBe(0);
  machineError(run.stdout, "E_USAGE");
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a candidate launcher without the manager gets no upgrade command", async () => {
  const report = await observeUpdate({
    env: { HACK_CANDIDATE_ENTRYPOINT: "/example/bundle/bin/hack-v5" },
    homeDir: "/example/user",
    version: "5.0.0-next.17",
    executable: "/example/bun",
    compiled: false,
    fetch: releases({ list: [{ tag_name: "v5.0.0-next.18" }] }).fetch,
  });
  expect(report).toMatchObject({
    install_kind: "candidate",
    available: true,
    upgrade_command: null,
    reason: null,
  });
});

/** A full first page: older stable releases fill it unless `extra` takes slots. */
function fullPage(extra: readonly string[]): unknown[] {
  const tags = [...extra];
  for (let index = 0; tags.length < 100; index++) {
    tags.push(`v4.0.${index}`);
  }
  return tags.map((tag_name) => ({ tag_name, draft: false }));
}

test("a full page proves 'up to date' only when it holds the running release", async () => {
  const observe = (list: unknown[]) =>
    observeUpdate({
      ...base,
      version: "5.0.0-next.17",
      executable: "/example/bun",
      compiled: false,
      fetch: releases({ list }).fetch,
    });
  // Older candidates only, and not the running one: a newer one may be on page two.
  expect(await observe(fullPage(["v5.0.0-next.16"]))).toMatchObject({
    latest: null,
    available: null,
    reason: "release-unavailable",
  });
  // The running release is listed, so everything created after it is too.
  expect(
    await observe(fullPage(["v5.0.0-next.17", "v5.0.0-next.16"]))
  ).toMatchObject({ latest: "5.0.0-next.17", available: false, reason: null });
  // A newer candidate on the page is positive evidence either way.
  expect(await observe(fullPage(["v5.0.0-next.18"]))).toMatchObject({
    latest: "5.0.0-next.18",
    available: true,
  });
  // A short page is the whole list.
  expect(await observe([{ tag_name: "v5.0.0-next.16" }])).toMatchObject({
    latest: "5.0.0-next.16",
    available: false,
    reason: null,
  });
});
