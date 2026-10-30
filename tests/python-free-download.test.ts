import { afterEach, expect, spyOn, test } from "bun:test";
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
import { TransferBudget } from "../scripts/installer/transfer-budget.ts";

const roots: string[] = [];
afterEach(() => {
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
    ).rejects.toThrow("interruption");
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
  now = 0;
  private readonly jobs: {
    due: number;
    callback: () => void;
    active: boolean;
  }[] = [];
  schedule = (callback: () => void, milliseconds: number) => {
    const job = { due: this.now + milliseconds, callback, active: true };
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
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
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
      await drain();
      if (scenario === "stall") {
        clock.advance(31);
      } else {
        for (let i = 0; i < (scenario === "progress" ? 3 : 4); i++) {
          clock.advance(20);
          controller?.enqueue(Uint8Array.of(65));
          await drain();
        }
        if (scenario === "progress") {
          controller?.close();
        } else {
          clock.advance(21);
        }
      }
      const result = await settled;
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
