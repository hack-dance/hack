import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curlTransferFlags } from "../scripts/installer/bootstrap.ts";
import { download, officialArchive } from "../scripts/installer/download.ts";
import { hash, jsonBytes } from "../scripts/installer/integrity.ts";
import {
  TransferBudget,
  TransferCleanupUncertain,
} from "../src/lib/release-transfer-budget.ts";

const roots: string[] = [];
afterEach(() => {
  // A test that fails or times out before its own finally must not leave
  // fetch spied for the next one (HACK-2250).
  mock.restore();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hack-download-")));
  roots.push(root);
  return root;
}
function fetchMock(
  implementation: (...args: Parameters<typeof fetch>) => Promise<Response>
): typeof fetch {
  return Object.assign(implementation, { preconnect: fetch.preconnect });
}

test("download checks redirects before request and refuses short, oversized, interrupted or malformed responses", async () => {
  const root = scratch();
  let calls = 0;
  const mock = spyOn(globalThis, "fetch");
  try {
    mock.mockImplementation(
      fetchMock(() => {
        calls++;
        return Promise.resolve(
          Response.redirect("http://evil.invalid/payload", 302)
        );
      })
    );
    await expect(
      download("https://github.com/start", join(root, "redirect"), 10)
    ).rejects.toThrow("nonofficial");
    expect(calls).toBe(1);
    expect(existsSync(join(root, "redirect"))).toBe(false);
    for (const [name, response, error] of [
      [
        "short",
        new Response("abc", { headers: { "content-length": "4" } }),
        "incomplete",
      ],
      [
        "over",
        new Response("abcd", { headers: { "content-length": "3" } }),
        "declared length",
      ],
      ["limit", new Response("abcd"), "size budget"],
      [
        "declared",
        new Response("abc", { headers: { "content-length": "400" } }),
        "size budget",
      ],
      [
        "malformed",
        new Response("abc", { headers: { "content-length": "3x" } }),
        "Malformed",
      ],
      ["status", new Response("no", { status: 404 }), "download failed"],
    ] as const) {
      mock.mockResolvedValue(response);
      await expect(
        download(
          "https://github.com/file",
          join(root, name),
          name === "short" ? 4 : 3
        )
      ).rejects.toThrow(error);
    }
    mock.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("fixture transport interruption"));
          },
        })
      )
    );
    await expect(
      download("https://github.com/file", join(root, "interrupted"), 10)
    ).rejects.toThrow("interrupted");
    mock.mockImplementation(
      fetchMock((_url, options) => {
        expect(options?.redirect).toBe("manual");
        expect(options?.signal).toBeDefined();
        return Promise.resolve(
          new Response("abc", { headers: { "content-length": "3" } })
        );
      })
    );
    await download("https://github.com/file", join(root, "complete"), 3);
    expect(readFileSync(join(root, "complete"), "utf8")).toBe("abc");
  } finally {
    mock.mockRestore();
  }
});

test("official release download binds exact assets, immutable tag and metadata; never runs payload", async () => {
  const version = "5.0.0-next.9";
  const revision = "a".repeat(40);
  const name = `hack-${version}-darwin-arm64-native.tar.gz`;
  const base = `https://github.com/hack-dance/hack/releases/download/v${version}/`;
  const archive = Buffer.from(
    "archive fixture; extraction is tested separately"
  );
  const release = {
    tag_name: `v${version}`,
    prerelease: true,
    draft: false,
    assets: [name, "prerelease.json", "SHA256SUMS"].map((name) => ({
      name,
      browser_download_url: base + name,
    })),
  };
  const metadata = {
    schema: "hack.prerelease/v1",
    version,
    tag: `v${version}`,
    source_revision: revision,
    platform: "darwin-arm64",
  };
  const mock = spyOn(globalThis, "fetch");
  const responses = (
    changed: Record<string, Buffer> = {}
  ): Record<string, Buffer> => ({
    [`https://api.github.com/repos/hack-dance/hack/releases/tags/v${version}`]:
      jsonBytes(release),
    [`${base}prerelease.json`]: jsonBytes(metadata),
    [`https://api.github.com/repos/hack-dance/hack/git/ref/tags/v${version}`]:
      jsonBytes({
        ref: `refs/tags/v${version}`,
        object: { type: "commit", sha: revision },
      }),
    [`${base}SHA256SUMS`]: Buffer.from(`${hash(archive)}  ${name}\n`),
    [`${base}${name}`]: archive,
    ...changed,
  });
  try {
    let data = responses();
    mock.mockImplementation(
      fetchMock((url) => {
        const bytes = data[String(url)];
        expect(bytes).toBeDefined();
        if (!bytes) {
          throw new Error("Unexpected fixture request");
        }
        return Promise.resolve(new Response(bytes.toString("utf8")));
      })
    );
    const result = await officialArchive(scratch(), version);
    expect(result.checksum).toBe(hash(archive));
    expect(readFileSync(result.archive)).toEqual(archive);
    const changes: Record<string, Buffer>[] = [
      {
        [`https://api.github.com/repos/hack-dance/hack/releases/tags/v${version}`]:
          jsonBytes({ ...release, draft: true }),
      },
      {
        [`https://api.github.com/repos/hack-dance/hack/releases/tags/v${version}`]:
          jsonBytes({
            ...release,
            assets: [...release.assets, release.assets[0]],
          }),
      },
      {
        [`https://api.github.com/repos/hack-dance/hack/releases/tags/v${version}`]:
          jsonBytes({
            ...release,
            assets: [
              { name, browser_download_url: "https://evil.invalid/file" },
            ],
          }),
      },
      {
        [`https://api.github.com/repos/hack-dance/hack/git/ref/tags/v${version}`]:
          jsonBytes({
            ref: `refs/tags/v${version}`,
            object: { type: "commit", sha: "b".repeat(40) },
          }),
      },
    ];
    for (const changed of changes) {
      data = responses(changed);
      await expect(officialArchive(scratch(), version)).rejects.toThrow();
    }
  } finally {
    mock.mockRestore();
  }
});

class FixtureClock {
  get activeCount() {
    return this.jobs.filter((job) => job.active).length;
  }
  now = 0;
  private readonly jobs: {
    due: number;
    delay: number;
    callback: () => void;
    active: boolean;
  }[] = [];
  /** Whether a timer of exactly this delay is armed and has not fired. */
  isArmed(milliseconds: number) {
    return this.jobs.some((job) => job.active && job.delay === milliseconds);
  }
  schedule = (callback: () => void, milliseconds: number) => {
    const job = {
      due: this.now + milliseconds,
      delay: milliseconds,
      callback,
      active: true,
    };
    this.jobs.push(job);
    return () => {
      job.active = false;
    };
  };
  advance(milliseconds: number) {
    const end = this.now + milliseconds;
    for (;;) {
      const job = this.jobs
        .filter((item) => item.active && item.due <= end)
        .sort((a, b) => a.due - b.due)[0];
      if (!job) {
        break;
      }
      this.now = job.due;
      job.active = false;
      job.callback();
    }
    this.now = end;
  }
}
const drain = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
/** Real-time bound for a fixture step; well under Bun's 5 s default test timeout. */
const STEP_BOUND_MS = 2000;
/**
 * Drains until `ready` holds, bounded in real time. One drain is not enough
 * when the code under test does real I/O first (the download opens its target
 * file before it reads), and advancing the fixture clock before a timer is
 * armed leaves that timer unfired for good (HACK-2250).
 */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + STEP_BOUND_MS;
  while (!ready()) {
    if (performance.now() >= deadline) {
      throw new Error(
        `Fixture step did not happen within ${STEP_BOUND_MS} ms: ${what}.`
      );
    }
    await drain();
  }
}
/** Awaits `promise`, failing with `what` after the step bound instead of hanging. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Fixture step did not happen within ${STEP_BOUND_MS} ms: ${what}.`
              )
            ),
          STEP_BOUND_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const scenario of ["progress", "stall", "total"] as const) {
  test(`HTTP transfer budget deterministically distinguishes ${scenario}`, async () => {
    const root = scratch();
    const clock = new FixtureClock();
    const budget = new TransferBudget({
      inactivityMs: 30,
      totalMs: 100,
      schedule: clock.schedule,
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    // With no prefetch (highWaterMark 0), pull runs only while the download
    // has a read pending: the handshake each clock tick waits for (HACK-2250).
    let readPending = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull() {
          readPending = true;
        },
      },
      { highWaterMark: 0 }
    );
    const nextRead = async () => {
      await until(() => readPending, "download read pending");
      readPending = false;
    };
    const mock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream)
    );
    try {
      const transfer = download(
        "https://github.com/file",
        join(root, "download"),
        100,
        budget
      );
      // Bun's promise matcher can wait eagerly; drive the fake clock before asserting.
      const settled = transfer.then(
        () => ({ ok: true, error: "" }),
        (error) => ({ ok: false, error: String(error) })
      );
      // Each tick waits until the download is reading: it opens and writes
      // its file with real I/O, and a tick before the read is a false stall.
      if (scenario === "stall") {
        await nextRead();
        clock.advance(31);
      } else {
        for (let i = 0; i < (scenario === "progress" ? 3 : 4); i++) {
          await nextRead();
          clock.advance(20);
          controller?.enqueue(Uint8Array.of(65));
        }
        await nextRead();
        if (scenario === "progress") {
          controller?.close();
        } else {
          clock.advance(21);
        }
      }
      const result = await within(settled, "download settled");
      expect(result.ok).toBe(scenario === "progress");
      if (scenario !== "progress") {
        expect(result.error).toContain(
          scenario === "stall" ? "inactivity budget" : "total transfer budget"
        );
      }
      if (scenario === "progress") {
        expect(clock.now).toBe(60);
        expect(readFileSync(join(root, "download"), "utf8")).toBe("AAA");
      }
    } finally {
      budget.close();
      mock.mockRestore();
    }
  });
}

test("curl's production low-speed and total-budget flags accept progressing loopback bytes and refuse a genuine stall", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      let timer: ReturnType<typeof setInterval> | undefined;
      const slow = new URL(request.url).pathname === "/progress";
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(slow ? 64 : 1).fill(65));
            if (slow) {
              let count = 1;
              timer = setInterval(() => {
                controller.enqueue(new Uint8Array(64).fill(65));
                if (++count === 16) {
                  clearInterval(timer);
                  controller.close();
                }
              }, 100);
            }
          },
          cancel() {
            if (timer) {
              clearInterval(timer);
            }
          },
        })
      );
    },
  });
  try {
    const run = (path: string) =>
      Bun.spawn(
        [
          "/usr/bin/curl",
          "--proto",
          "=http",
          "--silent",
          "--show-error",
          ...curlTransferFlags({ inactivitySeconds: 1, totalSeconds: 4 }),
          `http://127.0.0.1:${server.port}/${path}`,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 }
      );
    const progress = run("progress");
    const bytes = await new Response(progress.stdout).bytes();
    expect(await progress.exited).toBe(0);
    expect(bytes.length).toBe(1024);
    const stall = run("stall");
    const error = await new Response(stall.stderr).text();
    expect(await stall.exited).toBe(28);
    expect(error).toContain("too slow");
    expect((await new Response(stall.stdout).bytes()).length).toBe(1);
  } finally {
    await server.stop(true);
  }
}, 10_000);

for (const scenario of [
  "redirect",
  "read-error",
  "stalled-read",
  "cleanup-rejection",
] as const) {
  test(`bounded cancellation refuses uncertain ${scenario} settlement and preserves the primary failure`, async () => {
    const root = scratch();
    const clock = new FixtureClock();
    const budget = new TransferBudget({
      inactivityMs: 30,
      totalMs: 100,
      cleanupMs: 5,
      schedule: clock.schedule,
    });
    let cancellations = 0;
    let rejectLate: ((reason: unknown) => void) | undefined;
    // With no prefetch, pull runs only while the download has a read pending.
    let readPending = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          if (scenario === "read-error" || scenario === "cleanup-rejection") {
            controller.enqueue(Uint8Array.of(1, 2));
          }
        },
        pull() {
          readPending = true;
        },
        cancel() {
          cancellations++;
          if (scenario === "cleanup-rejection") {
            return Promise.reject(new Error("fixture cancellation rejection"));
          }
          return new Promise<void>((_resolve, reject) => {
            rejectLate = reject;
          });
        },
      },
      { highWaterMark: 0 }
    );
    const response =
      scenario === "redirect"
        ? new Response(stream, {
            status: 302,
            headers: { location: "https://github.com/next" },
          })
        : new Response(stream);
    const mock = spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      const settled = download(
        "https://github.com/first",
        join(root, "target"),
        1,
        budget
      ).then(
        () => ({ error: undefined as unknown }),
        (error) => ({ error })
      );
      if (scenario === "stalled-read") {
        // The read must be pending before the inactivity budget expires: the
        // download opens its target (real I/O) first.
        await until(() => readPending, "download read pending");
        clock.advance(31);
      }
      if (scenario !== "cleanup-rejection") {
        // Advance only once the 5 ms cleanup grace is armed; earlier, the
        // advance fires nothing and the grace never expires.
        await until(() => clock.isArmed(5), "cleanup grace armed");
        clock.advance(5);
      }
      const { error } = await within(settled, "download settled");
      expect(error).toBeInstanceOf(TransferCleanupUncertain);
      expect(String(error)).toContain("settlement is uncertain");
      expect(cancellations).toBe(1);
      expect(mock).toHaveBeenCalledTimes(1);
      if (scenario === "read-error" || scenario === "cleanup-rejection") {
        expect(String((error as Error).cause)).toContain("size budget");
      }
      if (scenario === "stalled-read") {
        expect(String((error as Error).cause)).toContain("inactivity budget");
      }
      if (scenario === "redirect") {
        expect(existsSync(join(root, "target"))).toBe(false);
      }
      rejectLate?.(
        new Error("fixture producer rejected after cleanup deadline")
      );
      await drain();
    } finally {
      budget.close();
      mock.mockRestore();
    }
    expect(clock.activeCount).toBe(0);
  });
}

test("a redirect proceeds only after actual cancellation settlement, and genuine EOF still succeeds", async () => {
  const root = scratch();
  const clock = new FixtureClock();
  const budget = new TransferBudget({
    inactivityMs: 30,
    totalMs: 100,
    cleanupMs: 5,
    schedule: clock.schedule,
  });
  let cancelled = false;
  let calls = 0;
  const mock = spyOn(globalThis, "fetch").mockImplementation(
    fetchMock(() => {
      if (++calls === 1) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 302, headers: { location: "https://github.com/next" } }
          )
        );
      }
      expect(cancelled).toBe(true);
      return Promise.resolve(new Response("ok"));
    })
  );
  try {
    await download("https://github.com/first", join(root, "target"), 2, budget);
    expect(readFileSync(join(root, "target"), "utf8")).toBe("ok");
    expect(calls).toBe(2);
  } finally {
    budget.close();
    mock.mockRestore();
  }
  expect(clock.activeCount).toBe(0);
});

function officialSequenceFixture() {
  const version = "5.0.0-next.9";
  const tag = `v${version}`;
  const revision = "a".repeat(40);
  const name = `hack-${version}-darwin-arm64-native.tar.gz`;
  const base = `https://github.com/hack-dance/hack/releases/download/${tag}/`;
  const archive = Buffer.from(
    "bounded archive bytes; parser controls are separate"
  );
  const responses: Record<string, Buffer> = {
    [`https://api.github.com/repos/hack-dance/hack/releases/tags/${tag}`]:
      jsonBytes({
        tag_name: tag,
        prerelease: true,
        draft: false,
        assets: [name, "prerelease.json", "SHA256SUMS"].map((name) => ({
          name,
          browser_download_url: base + name,
        })),
      }),
    [`${base}prerelease.json`]: jsonBytes({
      schema: "hack.prerelease/v1",
      version,
      tag,
      source_revision: revision,
      platform: "darwin-arm64",
    }),
    [`https://api.github.com/repos/hack-dance/hack/git/ref/tags/${tag}`]:
      jsonBytes({
        ref: `refs/tags/${tag}`,
        object: { type: "commit", sha: revision },
      }),
    [`${base}SHA256SUMS`]: Buffer.from(`${hash(archive)}  ${name}\n`),
    [base + name]: archive,
  };
  return { version, name, archive, responses };
}
for (const scenario of ["success", "total", "stall", "cleanup"] as const) {
  test(`five-file official sequence shares a monotonic total and bounded cleanup: ${scenario}`, async () => {
    const fixture = officialSequenceFixture();
    const root = scratch();
    const clock = new FixtureClock();
    const budget = new TransferBudget({
      inactivityMs: 30,
      totalMs: 100,
      cleanupMs: 5,
      schedule: clock.schedule,
    });
    let calls = 0;
    let cancellations = 0;
    let archiveReadPending = false;
    let archiveDelivered = false;
    const signals: unknown[] = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation(
      fetchMock((url, options) => {
        calls++;
        signals.push(options?.signal);
        const bytes = fixture.responses[String(url)];
        if (!bytes) {
          throw new Error("Unexpected official fixture URL");
        }
        if (scenario === "total") {
          clock.advance(25);
        }
        if (scenario === "success") {
          clock.advance(15);
        }
        if (
          (scenario === "stall" && calls === 2) ||
          (scenario === "cleanup" && calls === 5)
        ) {
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    if (scenario === "cleanup") {
                      if (archiveDelivered) {
                        archiveReadPending = true;
                      } else {
                        archiveDelivered = true;
                        controller.enqueue(fixture.archive);
                      }
                    }
                  },
                  cancel() {
                    cancellations++;
                    if (scenario === "cleanup") {
                      return new Promise<void>(() => {});
                    }
                  },
                },
                { highWaterMark: 0 }
              )
            )
          );
        }
        return Promise.resolve(new Response(bytes.toString("utf8")));
      })
    );
    try {
      const settled = officialArchive(root, fixture.version, budget).then(
        (value) => ({ value, error: undefined as unknown }),
        (error) => ({ value: undefined, error })
      );
      if (scenario === "stall" || scenario === "cleanup") {
        // With no stream prefetch, the next pull proves the archive write was
        // awaited. Fetch starting alone does not prove even open() has finished.
        await until(
          () => (scenario === "cleanup" ? archiveReadPending : calls >= 2),
          scenario === "cleanup" ? "archive read pending" : "second fetch"
        );
        expect(calls).toBe(scenario === "stall" ? 2 : 5);
        if (scenario === "cleanup") {
          expect(archiveReadPending).toBe(true);
        }
        clock.advance(31);
        await drain();
        if (scenario === "cleanup") {
          await until(() => cancellations > 0, "archive cancellation");
          expect(cancellations).toBe(1);
          clock.advance(5);
        }
      }
      const result = await within(settled, "download settled");
      expect(new Set(signals).size).toBe(1);
      if (scenario === "success") {
        expect(result.error).toBeUndefined();
        expect(calls).toBe(5);
        expect(clock.now).toBe(75);
        expect(readFileSync(result.value?.archive as string)).toEqual(
          fixture.archive
        );
      } else {
        expect(result.value).toBeUndefined();
        expect(String(result.error)).toContain(
          scenario === "total"
            ? "total transfer budget"
            : scenario === "stall"
              ? "inactivity budget"
              : "settlement is uncertain"
        );
        expect(calls).toBe(
          scenario === "total" ? 4 : scenario === "stall" ? 2 : 5
        );
      }
      if (scenario === "cleanup") {
        expect(cancellations).toBe(1);
        expect(readFileSync(join(root, fixture.name))).toEqual(fixture.archive);
        expect(result.error).toBeInstanceOf(TransferCleanupUncertain);
      }
    } finally {
      budget.close();
      mock.mockRestore();
    }
    expect(clock.activeCount).toBe(0);
  });
}
