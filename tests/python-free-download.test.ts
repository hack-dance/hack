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
import { download, officialArchive } from "../scripts/installer/download.ts";
import { hash, jsonBytes } from "../scripts/installer/integrity.ts";

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
