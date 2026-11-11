import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  COMPONENTS,
  classify,
  delta,
  ISSUE_TITLE,
  main,
  parseTag,
  plan,
  type Release,
  readPins,
  renderBody,
  WATCHED_INTERFACES,
} from "../scripts/provider-pin-watch.ts";

const repository = resolve(import.meta.dir, "..");
const smolvm = COMPONENTS.find((component) => component.key === "smolvm");
const docker = COMPONENTS.find((component) => component.key === "docker");

function release(
  tag: string,
  body = "",
  extra: Partial<Release> = {}
): Release {
  return {
    tag_name: tag,
    published_at: "2026-11-01T00:00:00Z",
    html_url: `https://example.invalid/${tag}`,
    prerelease: false,
    draft: false,
    body,
    ...extra,
  };
}

describe("provider pin watch", () => {
  test("tags parse only for the component's stable form", () => {
    expect(parseTag("v1.34.1", "v")).toEqual([1, 34, 1]);
    expect(parseTag("docker-v29.9.3", "docker-v")).toEqual([29, 9, 3]);
    expect(parseTag("docker-v29.10.0-rc.1", "docker-v")).toBeNull();
    expect(parseTag("client/v0.6.2", "docker-v")).toBeNull();
    expect(parseTag("v1.34", "v")).toBeNull();
  });

  test("the delta keeps newer stable releases, oldest first", () => {
    if (!(smolvm && docker)) {
      throw new Error("components");
    }
    const result = delta(smolvm, "1.32.4", [
      release("v1.34.1"),
      release("v1.35.0-rc1", "", { prerelease: true }),
      release("v1.33.0"),
      release("v1.32.4"),
      release("v1.32.3"),
      release("v1.36.0", "", { draft: true }),
      release("nightly"),
    ]);
    expect(result.releases.map((item) => item.tag)).toEqual([
      "v1.33.0",
      "v1.34.1",
    ]);
    expect(
      delta(docker, "29.5.2", [
        release("docker-v29.9.3"),
        release("client/v0.6.2"),
      ]).releases.map((item) => item.tag)
    ).toEqual(["docker-v29.9.3"]);
    expect(() => delta(smolvm, "1.32", [])).toThrow("major.minor.patch");
  });

  test("notes are classified by category and watched interface", () => {
    expect(
      classify("Bump libkrunfw to the 6.18 kernel for CVE-2026-98432")
    ).toEqual(["security advisory", "libkrun/libkrunfw"]);
    expect(classify("Pin libkrun at the vsock muxer guard fix")).toEqual([
      "libkrun/libkrunfw",
      "vsock",
    ]);
    expect(classify("Keep balloon page releases inside one region")).toEqual([
      "balloon/reclaim",
    ]);
    expect(classify("Copy disk templates without writing zero runs")).toEqual([
      "disk/template/trim",
    ]);
    expect(
      classify("Fix --docker-socket forwarding; SMOLVM_IDLE_RECLAIM now 2")
    ).toEqual(["`--docker-socket`", "`SMOLVM_IDLE_RECLAIM`"]);
    expect(classify("Add --volumes-from and --labels")).toEqual([]);
    expect(classify("Update rustls for RUSTSEC-2026-0346")).toEqual([
      "security advisory",
    ]);
    expect(classify("Serve virtio-fs shares faster")).toEqual(["virtiofs"]);
    expect(classify("Improve the README")).toEqual([]);
  });

  test("every watched interface is still passed or read by the runtime", () => {
    const provider = join(repository, "packages/runtime-core/src/provider");
    const source = ["lifecycle.rs", "network_intent.rs"]
      .map((name) => readFileSync(join(provider, name), "utf8"))
      .join("\n");
    for (const name of WATCHED_INTERFACES) {
      expect(source.includes(`"${name}"`)).toBe(true);
    }
  });

  test("the pins file names every watched component", () => {
    const pins = readPins(
      join(repository, "packages/runtime-core/provider-pins.json")
    );
    expect([...pins.keys()]).toEqual(["smolvm", "docker", "buildx"]);
  });

  test("the plan creates, updates, closes or leaves the one issue", () => {
    if (!smolvm) {
      throw new Error("components");
    }
    const behind = [
      delta(smolvm, "1.33.0", [
        release("v1.34.1", "Fix GHSA-abcd-1234 in vsock"),
      ]),
    ];
    const current = [delta(smolvm, "1.34.1", [release("v1.34.1")])];
    expect(plan(behind, null, "2026-11-11")).toMatchObject({
      action: "create",
      labels: ["security"],
    });
    expect(plan(behind, { state: "closed" }, "2026-11-11").action).toBe(
      "update"
    );
    expect(plan(current, { state: "open" }, "2026-11-11").action).toBe("close");
    expect(plan(current, { state: "closed" }, "2026-11-11").action).toBe(
      "none"
    );
    expect(plan(current, null, "2026-11-11")).toMatchObject({
      action: "none",
      labels: [],
    });
    const body = renderBody(behind, "2026-11-11");
    expect(body).toContain("| SmolVM | 1.33.0 | v1.34.1 | 1 |");
    expect(body).toContain(
      "| [v1.34.1](https://example.invalid/v1.34.1) | 2026-11-01 | security advisory, vsock |"
    );
  });

  test("a run files one labelled issue through the API and a dry run writes nothing", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const responses = (method: string, url: string): [number, unknown] => {
      if (url.includes("/repos/smol-machines/smolvm/releases")) {
        return [
          200,
          [
            release("v99.0.0", "Security fix for RUSTSEC-2026-0001"),
            release("v1.0.0"),
          ],
        ];
      }
      if (url.includes("/releases")) {
        return [200, []];
      }
      if (url.includes("/issues?")) {
        return [200, [{ number: 4, title: "Other", state: "open" }]];
      }
      if (method === "POST" && url.endsWith("/labels")) {
        return [422, { message: "exists" }];
      }
      if (method === "POST" && url.endsWith("/issues")) {
        return [201, { number: 5 }];
      }
      return [500, {}];
    };
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const [status, value] = responses(method, url);
      return new Response(JSON.stringify(value), { status });
    }) as typeof fetch;
    const env = { GITHUB_TOKEN: "synthetic", GITHUB_REPOSITORY: "owner/repo" };
    const log = console.log;
    console.log = () => undefined;
    try {
      expect(await main(["--dry-run"], env, fetcher)).toBe(0);
      expect(calls.every((call) => call.method === "GET")).toBe(true);
      calls.length = 0;
      expect(await main([], env, fetcher)).toBe(0);
      expect(
        await main(
          [],
          { GITHUB_TOKEN: "x", GITHUB_REPOSITORY: "bad repo" },
          fetcher
        )
      ).toBe(64);
    } finally {
      console.log = log;
    }
    const created = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/issues")
    );
    expect(created?.body).toMatchObject({
      title: ISSUE_TITLE,
      labels: ["security"],
    });
    expect(String((created?.body as { body: string }).body)).toContain(
      "v99.0.0"
    );
    expect(
      calls.some((call) => call.url.endsWith("/repos/owner/repo/labels"))
    ).toBe(true);
  });
});
