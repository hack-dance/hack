import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReleaseArchive } from "../scripts/build-release.ts";
import { download } from "../scripts/installer/download.ts";
import { publishRelease } from "../src/lib/release-install.ts";
import { verifyReleaseDirectory } from "../src/lib/release-integrity.ts";
import {
  type ReleaseFetch,
  transferRelease,
} from "../src/lib/release-transfer.ts";
import {
  TransferBudget,
  TransferCleanupUncertain,
} from "../src/lib/release-transfer-budget.ts";
import {
  downloadAndExtractRelease,
  installExtractedRelease,
} from "../src/lib/self-update.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop(true);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function scratch() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-upgrade-installer-"))
  );
  roots.push(root);
  return root;
}
const official =
  "https://github.com/hack-dance/hack/releases/download/v4.3.1/hack-4.3.1-linux-x86_64.tar.gz";
const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function serverFixture(handler: (count: number) => Response) {
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => handler(++count),
  });
  servers.push(server);
  // Production still validates every official URL and redirect. Only this
  // explicit function maps that URL to an ephemeral loopback server.
  const request: ReleaseFetch = (_url, init) =>
    fetch(`http://127.0.0.1:${server.port}/asset`, init);
  return { request, calls: () => count };
}
async function releaseFixture(
  root: string,
  version = "4.3.1",
  fault?: "checksum" | "version"
) {
  const release = join(root, `hack-${version}-release`);
  await mkdir(join(release, "assets"), { recursive: true });
  await mkdir(join(release, "binaries"));
  const files: Record<string, string> = {
    hack: `#!/bin/sh\ncase "$0" in */.hack-update-stage-*/hack) ;; *) exit 93 ;; esac\nprintf '%s\\n' 'hack v${fault === "version" ? "4.3.0" : version}'\n`,
    "hack-config-compiler": "#!/bin/sh\nexit 0\n",
    "assets/schema.json": "new schema\n",
    "binaries/tool": "bundled executable\n",
  };
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(release, name), bytes, {
      mode: name.startsWith("hack") ? 0o755 : 0o600,
    });
  }
  const archive = await writeReleaseArchive({
    releaseRoot: root,
    version,
    target: { platform: "linux", arch: "x86_64" },
  });
  if (fault === "checksum") {
    await writeFile(join(release, "assets/schema.json"), "corrupted payload\n");
    // Corrupt payload without changing the producer's checksum inventory.
    const child = Bun.spawn(
      ["tar", "-czf", archive, "-C", root, `hack-${version}-release`],
      {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      }
    );
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
  }
  return { release, archive, bytes: new Uint8Array(await readFile(archive)) };
}

for (const fault of ["checksum", "version"] as const) {
  test(`stable update refuses a release with wrong ${fault} before publication`, async () => {
    const root = await scratch();
    const f = await releaseFixture(root, "4.3.1", fault);
    const server = serverFixture(() => new Response(f.bytes));
    const before = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("hack-update-"))
      .sort();
    const result = await downloadAndExtractRelease({
      url: official,
      version: "4.3.1",
      request: server.request,
    });
    expect(result.ok).toBe(fault === "version");
    if (result.ok) {
      // Version execution belongs to the executable stage beside bin/hack,
      // never os.tmpdir(), which may be mounted noexec.
      try {
        const install = await installExtractedRelease({
          version: "4.3.1",
          extractedReleaseDir: result.extractedReleaseDir,
          binaryPath: join(root, "bin/hack"),
          assetsDir: join(root, "installed-assets"),
        });
        expect(install.ok).toBe(false);
        if (!install.ok) {
          expect(install.error).toContain("version does not match");
        }
        expect(await Bun.file(join(root, "bin/hack")).exists()).toBe(false);
      } finally {
        await rm(result.tmpDir, { recursive: true, force: true });
      }
    } else {
      expect(result.error).toContain("checksum mismatch");
    }
    expect(
      (await readdir(tmpdir()))
        .filter((name) => name.startsWith("hack-update-"))
        .sort()
    ).toEqual(before);
  });
}
for (const native of [false, true]) {
  test(`${native ? "prerelease" : "stable"} download restarts a truncated transfer and retries 503 within one budget`, async () => {
    const root = await scratch();
    const bytes = "complete verified download";
    const f = serverFixture((count) =>
      count === 1
        ? new Response("retry", { status: 503 })
        : new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    count === 2 ? bytes.slice(0, 5) : bytes
                  )
                );
                await new Promise((resolve) => setTimeout(resolve, 10));
                if (count === 2) {
                  controller.error(new Error("fixture connection interrupted"));
                } else {
                  controller.close();
                }
              },
            }),
            { headers: { "content-length": String(bytes.length) } }
          )
    );
    const path = join(root, "download");
    const budget = new TransferBudget({ totalMs: 5000, inactivityMs: 1000 });
    try {
      if (native) {
        await download(official, path, 1024, budget, f.request);
      } else {
        await transferRelease({
          url: official,
          path,
          sha256: sha(bytes),
          request: f.request,
          budget,
        });
      }
      expect(await readFile(path, "utf8")).toBe(bytes);
      expect(f.calls()).toBe(3);
      expect(await readdir(root)).toEqual(["download"]);
    } finally {
      budget.close();
    }
  }, 10_000);
}
test("bad checksum, 404, size overflow, stalled body and offline leave no partial install", async () => {
  const root = await scratch();
  for (const kind of ["checksum", "404", "size", "offline", "stall"]) {
    let calls = 0;
    const path = join(root, kind);
    const request: ReleaseFetch = async () => {
      calls++;
      if (kind === "offline") {
        throw new TypeError("fixture offline");
      }
      if (kind === "stall") {
        return new Response(
          new ReadableStream({
            pull: () => new Promise(() => {}),
            cancel: () => {},
          })
        );
      }
      return new Response("payload", { status: kind === "404" ? 404 : 200 });
    };
    await expect(
      transferRelease({
        url: official,
        path,
        request,
        sha256: "0".repeat(64),
        maxBytes: kind === "size" ? 2 : 1024,
        idleMs: kind === "offline" ? 500 : 100,
        timeoutMs: 1000,
      })
    ).rejects.toThrow(kind === "offline" ? "Network unavailable" : undefined);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(calls).toBe(kind === "offline" ? 3 : 1);
  }
});
test("uncertain cancellation never retries or masquerades as a completed transfer", async () => {
  const root = await scratch();
  let calls = 0;
  const budget = new TransferBudget({
    totalMs: 1000,
    inactivityMs: 30,
    cleanupMs: 30,
  });
  try {
    await expect(
      transferRelease({
        url: official,
        path: join(root, "partial"),
        budget,
        request: async () => {
          calls++;
          return new Response(
            new ReadableStream({
              pull: () => new Promise(() => {}),
              cancel: () => new Promise(() => {}),
            })
          );
        },
      })
    ).rejects.toBeInstanceOf(TransferCleanupUncertain);
    expect(calls).toBe(1);
  } finally {
    budget.close();
  }
});
test("existing download and unofficial redirect are never overwritten or followed", async () => {
  const root = await scratch();
  const path = join(root, "keep");
  await writeFile(path, "existing bytes");
  const f = serverFixture(() => new Response("other bytes"));
  await expect(
    transferRelease({ url: official, path, request: f.request })
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("existing bytes");
  let calls = 0;
  await expect(
    transferRelease({
      url: official,
      path: join(root, "foreign"),
      request: async () => {
        calls++;
        return Response.redirect("https://foreign.invalid/asset", 302);
      },
    })
  ).rejects.toThrow("nonofficial");
  expect(calls).toBe(1);
});
test("v4 release layout downloads, verifies every payload and executes the selected version", async () => {
  const root = await scratch();
  const f = await releaseFixture(root);
  const server = serverFixture(() => new Response(f.bytes));
  const result = await downloadAndExtractRelease({
    url: official,
    version: "4.3.1",
    sha256: sha(f.bytes),
    request: server.request,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  roots.push(result.tmpDir);
  expect(
    await Bun.file(join(result.extractedReleaseDir, "hack")).exists()
  ).toBe(true);
  expect(
    await Bun.file(
      join(result.extractedReleaseDir, "assets/schema.json")
    ).exists()
  ).toBe(true);
  expect(
    await Bun.file(join(result.extractedReleaseDir, "binaries/tool")).exists()
  ).toBe(true);
  await writeFile(join(f.release, "assets/schema.json"), "tampered");
  await expect(verifyReleaseDirectory(f.release)).rejects.toThrow(
    "checksum mismatch"
  );
  await writeFile(
    join(f.release, "SHA256SUMS"),
    `${"0".repeat(64)}  ../escape\n`
  );
  await expect(verifyReleaseDirectory(f.release)).rejects.toThrow("inventory");
});
for (const phase of [
  "staged",
  "assets-published",
  "compiler-published",
  "binary-published",
]) {
  test(`stable publication rolls back at ${phase}; a rerun installs matching binary/compiler/assets`, async () => {
    const root = await scratch();
    const f = await releaseFixture(root);
    const bin = join(root, "bin");
    const assets = join(root, "installed-assets");
    await mkdir(bin);
    await mkdir(assets);
    const binary = join(bin, "hack");
    const compiler = join(bin, "hack-config-compiler");
    await writeFile(binary, "old CLI");
    await writeFile(compiler, "old compiler");
    await writeFile(join(assets, "schema.json"), "old schema");
    await writeFile(join(assets, "mutagen"), "user managed extension");
    const opts = {
      version: "4.3.1",
      extractedReleaseDir: f.release,
      binaryPath: binary,
      assetsDir: assets,
    };
    await expect(
      publishRelease({
        ...opts,
        checkpoint: (point) => {
          if (point === phase) {
            throw new Error("fixture publication fault");
          }
        },
      })
    ).rejects.toThrow("fixture publication fault");
    expect(await readFile(binary, "utf8")).toBe("old CLI");
    expect(await readFile(compiler, "utf8")).toBe("old compiler");
    expect(await readFile(join(assets, "schema.json"), "utf8")).toBe(
      "old schema"
    );
    expect((await readdir(assets)).sort()).toEqual(["mutagen", "schema.json"]);
    const result = await publishRelease(opts);
    expect(await readFile(binary, "utf8")).toBe(
      await readFile(join(f.release, "hack"), "utf8")
    );
    expect(await readFile(compiler, "utf8")).toBe(
      await readFile(join(f.release, "hack-config-compiler"), "utf8")
    );
    expect(await readFile(join(assets, "schema.json"), "utf8")).toBe(
      "new schema\n"
    );
    expect(await readFile(join(assets, "mutagen"), "utf8")).toBe(
      "user managed extension"
    );
    expect(await readFile(join(result.backupManifest, "../hack"), "utf8")).toBe(
      "old CLI"
    );
    const manifest = await readFile(result.backupManifest, "utf8");
    for (const value of ["old CLI", "old schema", "user managed extension"]) {
      expect(manifest.includes(value)).toBe(false);
    }
    await publishRelease(opts);
    expect(await readFile(join(assets, "mutagen"), "utf8")).toBe(
      "user managed extension"
    );
    expect(
      (await readdir(bin)).some((name) =>
        name.startsWith(".hack-update-stage-")
      )
    ).toBe(false);
  });
}
test("stable uninstall can be repeated and preserves all user state", async () => {
  const root = await scratch();
  const home = join(root, "home");
  await mkdir(join(home, ".hack/bin"), { recursive: true });
  await writeFile(join(home, ".hack/bin/hack"), "fixture CLI");
  await writeFile(join(home, ".hack/keep"), "synthetic user data");
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "scripts/uninstall-cli.ts"],
      {
        env: privateCliEnv({ root, home }),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      }
    );
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
  }
  expect(await Bun.file(join(home, ".hack/bin/hack")).exists()).toBe(false);
  expect(await readFile(join(home, ".hack/keep"), "utf8")).toBe(
    "synthetic user data"
  );
});

test("an offline loopback release server fails clearly without a leftover download", async () => {
  const root = await scratch();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unused"),
  });
  const port = server.port;
  await server.stop(true);
  const target = join(root, "release");
  await expect(
    transferRelease({
      url: official,
      path: target,
      request: (_url, init) => fetch(`http://127.0.0.1:${port}/offline`, init),
      timeoutMs: 3000,
    })
  ).rejects.toThrow("Network unavailable");
  expect(await readdir(root)).toEqual([]);
});

for (const phase of ["assets-published", "compiler-published"]) {
  test(`a real hard kill at ${phase} leaves the previous built CLI able to rerun update`, async () => {
    const root = await scratch();
    const bin = join(root, "bin");
    const assets = join(root, "installed-assets");
    await mkdir(bin);
    await mkdir(assets);
    const binary = join(bin, "hack");
    const compiler = join(bin, "hack-config-compiler");
    // The compiler is a tripwire: update must not need either version of it.
    await writeFile(compiler, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    await writeFile(join(assets, "schema.json"), "old schema");
    const env = privateCliEnv({
      root,
      home: join(root, "home"),
      env: {
        HACK_HOME: join(root, "home/.hack"),
        HACK_ASSETS_DIR: assets,
        HACK_RUNTIME_BACKEND: "compose",
        HACK_NO_INTERACTIVE: "1",
      },
    });
    const build = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "build",
        "tests/fixtures/update-recovery-cli.ts",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-tsconfig",
        "--no-compile-autoload-package-json",
        "--outfile",
        binary,
      ],
      { env, stdout: "pipe", stderr: "pipe", timeout: 120_000 }
    );
    const [buildCode] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    expect(buildCode).toBe(0);
    const before = sha(await readFile(binary));
    const release = await releaseFixture(root);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "tests/fixtures/update-publication-child.ts",
        release.release,
        binary,
        assets,
        phase,
      ],
      { env, stdout: "pipe", stderr: "pipe", timeout: 10_000 }
    );
    await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(child.signalCode).toBe("SIGKILL");
    expect(sha(await readFile(binary))).toBe(before);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.includes("/releases/latest")) {
          return Response.json({
            tag_name: "v4.3.1",
            assets: [
              {
                name: `hack-4.3.1-${process.platform}-${process.arch === "x64" ? "x86_64" : "arm64"}.tar.gz`,
                browser_download_url: official,
                digest: `sha256:${sha(release.bytes)}`,
              },
            ],
          });
        }
        return new Response(release.bytes);
      },
    });
    servers.push(server);
    const mutagen = join(root, "mutagen");
    await writeFile(mutagen, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const retry = Bun.spawn([binary, "update", "--yes", "--json"], {
      env: {
        ...env,
        HACK_TEST_UPDATE_FIXTURE_ENDPOINT: `http://127.0.0.1:${server.port}`,
        HACK_MUTAGEN_PATH: mutagen,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const [code, stdout, stderr] = await Promise.all([
      retry.exited,
      new Response(retry.stdout).text(),
      new Response(retry.stderr).text(),
    ]);
    expect(code, stderr + stdout).toBe(0);
    expect(await readFile(binary, "utf8")).toBe(
      await readFile(join(release.release, "hack"), "utf8")
    );
    expect(await readFile(compiler, "utf8")).toBe(
      await readFile(join(release.release, "hack-config-compiler"), "utf8")
    );
    expect(await readFile(join(assets, "schema.json"), "utf8")).toBe(
      "new schema\n"
    );
  }, 150_000);
}

test("stage reclamation needs a private matching inode receipt and never removes unrecognized files", async () => {
  const { markReleaseStage, reclaimReleaseStages } = await import(
    "../src/lib/release-staging.ts"
  );
  const root = await scratch();
  const binary = join(root, "hack");
  const recognized = join(root, ".hack-update-stage-ABC123");
  const unknown = join(root, ".hack-update-stage-DEF456");
  const malformed = join(root, ".hack-update-stage-GHI789");
  for (const path of [recognized, unknown, malformed]) {
    await mkdir(path, { mode: 0o700 });
  }
  await markReleaseStage(recognized, binary);
  await writeFile(join(recognized, "hack"), "partial executable");
  await writeFile(join(unknown, "keep"), "unrecognized content");
  await writeFile(join(malformed, "stage.json"), "{", { mode: 0o600 });
  await reclaimReleaseStages(binary);
  expect((await readdir(root)).sort()).toEqual([
    ".hack-update-stage-DEF456",
    ".hack-update-stage-GHI789",
  ]);
  expect(await readFile(join(unknown, "keep"), "utf8")).toBe(
    "unrecognized content"
  );
});
