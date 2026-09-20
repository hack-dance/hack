import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { access, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { inspectCaddyCaIdentity } from "../src/lib/caddy-ca-identity.ts";
import type { ExecOptions, ExecResult } from "../src/lib/shell.ts";
import { CURRENT_CA_PEM, OLD_CA_PEM } from "./helpers/ca-certificates.ts";

const ID = "a".repeat(64);
const certificate = new X509Certificate(CURRENT_CA_PEM);
const now = Date.parse(certificate.validFrom) + 1000;
const secretError = "untrusted raw stderr must never appear";

function fixture(
  opts: {
    readonly exported?: string | null;
    readonly runtime?: string;
    readonly copyKind?: "symlink" | "directory" | "missing";
    readonly selected?: string;
    readonly metadata?: unknown;
    readonly inspectOutput?: string;
    readonly readFails?: boolean;
    readonly failureAt?: number;
    readonly throwAt?: number;
    readonly now?: number;
  } = {}
) {
  const calls: {
    readonly cmd: readonly string[];
    readonly options?: ExecOptions;
  }[] = [];
  let reads = 0;
  let runtimeReads = 0;
  let copiedPath: string | undefined;
  const run = () =>
    inspectCaddyCaIdentity({
      composeFile: "/owned/global/docker-compose.yml",
      certPath: "/owned/export/root.crt",
      now: opts.now ?? now,
      readTextFile: async (path) => {
        if (path !== "/owned/export/root.crt") {
          if (!copiedPath) {
            throw new Error("Expected a copied certificate path");
          }
          runtimeReads += 1;
          expect(path).toBe(copiedPath);
          return await Bun.file(path).text();
        }
        expect(path).toBe("/owned/export/root.crt");
        reads += 1;
        if (opts.readFails) {
          throw new Error(secretError);
        }
        return opts.exported === undefined ? CURRENT_CA_PEM : opts.exported;
      },
      exec: async (cmd, options): Promise<ExecResult> => {
        calls.push({ cmd, options });
        if (cmd[1] === "cp") {
          copiedPath = cmd[3];
          if (!copiedPath) {
            throw new Error("missing copy destination");
          }
          const directory = await lstat(dirname(copiedPath));
          expect(directory.isDirectory()).toBe(true);
          expect(directory.mode & 0o077).toBe(0);
          if (opts.copyKind === "symlink") {
            await symlink("/unowned/root.crt", copiedPath);
          } else if (opts.copyKind === "directory") {
            await mkdir(copiedPath);
          } else if (opts.copyKind !== "missing") {
            await writeFile(copiedPath, opts.runtime ?? CURRENT_CA_PEM);
          }
        }
        if (calls.length === opts.throwAt) {
          throw new Error(secretError);
        }
        if (calls.length === opts.failureAt) {
          return { exitCode: 124, stdout: "", stderr: secretError };
        }
        const outputs = [
          opts.selected ?? ID,
          opts.inspectOutput ??
            JSON.stringify(
              opts.metadata === undefined
                ? { id: ID, running: true, service: "caddy" }
                : opts.metadata
            ),
          opts.runtime ?? CURRENT_CA_PEM,
        ];
        return {
          exitCode: 0,
          stdout: outputs[calls.length - 1] ?? "",
          stderr: "",
        };
      },
    });
  return {
    run,
    calls,
    reads: () => reads,
    runtimeReads: () => runtimeReads,
    copiedPath: () => copiedPath,
  };
}

test("unchanged CA uses exact owned running container and bounded public-certificate read", async () => {
  const f = fixture();
  const result = await f.run();
  expect(result.state).toBe("current");
  expect(new X509Certificate(result.currentPem ?? "").raw).toEqual(
    certificate.raw
  );
  expect(f.calls[0]?.cmd).toEqual([
    "docker",
    "compose",
    "-f",
    "/owned/global/docker-compose.yml",
    "ps",
    "-q",
    "caddy",
  ]);
  expect(f.calls[1]?.cmd.slice(0, 5)).toEqual([
    "docker",
    "inspect",
    "--type",
    "container",
    "--format",
  ]);
  expect(f.calls[2]?.cmd).toEqual([
    "docker",
    "cp",
    `${ID}:/data/caddy/pki/authorities/local/root.crt`,
    f.copiedPath() as string,
  ]);
  expect(
    f.calls.some(
      (call) => call.cmd.includes("exec") || call.cmd.includes("head")
    )
  ).toBe(false);
  await expect(access(dirname(f.copiedPath() as string))).rejects.toThrow();
  expect(f.calls.map((call) => call.options)).toEqual(
    new Array(3).fill({ timeoutMs: 5000, stdin: "ignore" })
  );
});

test("rotation is stale even when both CA subjects are identical", async () => {
  expect(new X509Certificate(OLD_CA_PEM).subject).toBe(certificate.subject);
  const result = await fixture({ exported: OLD_CA_PEM }).run();
  expect(result.state).toBe("stale");
  expect(new X509Certificate(result.currentPem ?? "").raw).toEqual(
    certificate.raw
  );
});

test("PEM line ending differences do not change DER identity", async () => {
  expect(
    (await fixture({ exported: CURRENT_CA_PEM.replaceAll("\n", "\r\n") }).run())
      .state
  ).toBe("current");
});

test("missing export still inspects and validates the runtime CA", async () => {
  const f = fixture({ exported: null });
  const result = await f.run();
  expect(result.state).toBe("missing");
  expect(result.currentPem).toBeDefined();
  expect(f.calls).toHaveLength(3);
});

for (const exported of ["", "malformed", CURRENT_CA_PEM + OLD_CA_PEM]) {
  test(`malformed export is stale and eligible for explicit verified refresh (${exported.length})`, async () => {
    const result = await fixture({ exported }).run();
    expect(result.state).toBe("stale");
    expect(new X509Certificate(result.currentPem ?? "").raw).toEqual(
      certificate.raw
    );
  });
}

for (const runtime of [
  "",
  "malformed",
  CURRENT_CA_PEM + OLD_CA_PEM,
  CURRENT_CA_PEM.padEnd(65_537, " "),
]) {
  test(`invalid or oversized runtime cannot authorize an export (${runtime.length})`, async () => {
    const f = fixture({ runtime, exported: null });
    const result = await f.run();
    expect(result.state).toBe("invalid");
    expect(result.currentPem).toBeUndefined();
    expect(f.reads()).toBe(0);
  });
}

for (const time of [
  Date.parse(certificate.validFrom) - 1,
  Date.parse(certificate.validTo) + 1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
]) {
  test(`runtime validity must hold at the requested clock (${time})`, async () => {
    const result = await fixture({ now: time }).run();
    expect(result.state).toBe("invalid");
    expect(result.currentPem).toBeUndefined();
  });
}

for (const selected of [
  "",
  "a".repeat(11),
  "a".repeat(65),
  `${ID}\n${"b".repeat(64)}`,
  "--privileged",
  "foreign-name",
]) {
  test(`reject ambiguous or non-ID selection (${selected.length}) before inspection`, async () => {
    const f = fixture({ selected });
    expect((await f.run()).state).toBe("unavailable");
    expect(f.calls).toHaveLength(1);
  });
}

for (const metadata of [
  { id: ID, running: true, service: "foreign" },
  { id: ID, running: false, service: "caddy" },
  { id: "b".repeat(64), running: true, service: "caddy" },
  {},
  null,
  [],
]) {
  test(`reject unverified Caddy ownership or running state (${JSON.stringify(metadata)})`, async () => {
    const f = fixture({ metadata });
    const result = await f.run();
    expect(result.state).toBe("unavailable");
    expect(f.calls).toHaveLength(2);
    expect(result.currentPem).toBeUndefined();
  });
}

test("a single abbreviated ID must match the inspected full ID", async () => {
  expect((await fixture({ selected: ID.slice(0, 12) }).run()).state).toBe(
    "current"
  );
});

for (const step of [1, 2, 3]) {
  for (const kind of ["failureAt", "throwAt"] as const) {
    test(`${kind} at runtime step ${step} is sanitized unavailable`, async () => {
      const result = await fixture({ [kind]: step, exported: null }).run();
      expect(result.state).toBe("unavailable");
      expect(result.currentPem).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(secretError);
    });
  }
}

test("malformed inspect output never reaches docker cp", async () => {
  const f = fixture({ inspectOutput: "not JSON" });
  expect((await f.run()).state).toBe("unavailable");
  expect(f.calls).toHaveLength(2);
});

test("export read exceptions are sanitized and never publish a root", async () => {
  const result = await fixture({ readFails: true }).run();
  expect(result.state).toBe("unavailable");
  expect(result.currentPem).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(secretError);
});

test("a parseable non-CA runtime certificate cannot authorize export", async () => {
  // Public fixture-only DER mutation changes basicConstraints CA=true to false.
  const leaf = Buffer.from(certificate.raw);
  const offset = leaf.indexOf(Buffer.from([0x30, 0x03, 0x01, 0x01, 0xff]));
  expect(offset).toBeGreaterThan(-1);
  leaf[offset + 4] = 0;
  const nonCa = new X509Certificate(leaf);
  expect(nonCa.ca).toBe(false);
  const result = await fixture({ runtime: nonCa.toString() }).run();
  expect(result.state).toBe("invalid");
  expect(result.currentPem).toBeUndefined();
});

for (const copyKind of ["symlink", "directory", "missing"] as const) {
  test(`copied ${copyKind} is rejected before read and temporary directory is removed`, async () => {
    const f = fixture({ copyKind });
    const result = await f.run();
    expect(result.state).toBe(
      copyKind === "missing" ? "unavailable" : "invalid"
    );
    expect(result.currentPem).toBeUndefined();
    expect(f.runtimeReads()).toBe(0);
    await expect(access(dirname(f.copiedPath() as string))).rejects.toThrow();
  });
}

test("oversized copied root is removed before reading any certificate bytes", async () => {
  const f = fixture({ runtime: CURRENT_CA_PEM.padEnd(65_537, " ") });
  expect((await f.run()).state).toBe("invalid");
  expect(f.runtimeReads()).toBe(0);
  await expect(access(dirname(f.copiedPath() as string))).rejects.toThrow();
});

for (const kind of ["failureAt", "throwAt"] as const) {
  test(`copy ${kind} cleans up partially copied public certificate`, async () => {
    const f = fixture({ [kind]: 3 });
    expect((await f.run()).state).toBe("unavailable");
    expect(f.runtimeReads()).toBe(0);
    await expect(access(dirname(f.copiedPath() as string))).rejects.toThrow();
  });
}
