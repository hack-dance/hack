import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pinnedManifest from "../packages/runtime-core/provider-pins.json";
import {
  type Advisory,
  affecting,
  BOT_LOGIN,
  COMPONENTS,
  cell,
  checkPinnedUrls,
  classify,
  delta,
  GitHub,
  ISSUE_TITLE,
  inRange,
  link,
  main,
  parseTag,
  patched,
  plan,
  type Release,
  readPinnedFiles,
  readPins,
  renderBody,
  SMOLVM_INTERFACES,
  WATCH_LABEL,
} from "../scripts/provider-pin-watch.ts";

const repository = resolve(import.meta.dir, "..");
const provider = join(repository, "packages/runtime-core/src/provider");
const component = (key: string) => {
  const found = COMPONENTS.find((entry) => entry.key === key);
  if (!found) {
    throw new Error(key);
  }
  return found;
};
const smolvm = component("smolvm");
const docker = component("docker");

function release(
  tag: string,
  body = "",
  extra: Partial<Release> = {}
): Release {
  return {
    tag_name: tag,
    published_at: "2026-11-01T00:00:00Z",
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    prerelease: false,
    draft: false,
    body,
    ...extra,
  };
}

function advisory(
  id: string,
  range: string | null,
  patched = "99.0.0"
): Advisory {
  return {
    ghsa_id: id,
    html_url: `https://github.com/o/r/security/advisories/${id}`,
    severity: "high",
    summary: `Synthetic advisory ${id}`,
    vulnerabilities: [
      { vulnerable_version_range: range, patched_versions: patched },
    ],
  };
}

/** Every Rust source file under the provider module. */
function providerSource(): string {
  const read = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return read(path);
      }
      return entry.name.endsWith(".rs") ? [readFileSync(path, "utf8")] : [];
    });
  return read(provider).join("\n");
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) {
    throw new Error(`region ${start}..${end} not found`);
  }
  return source.slice(from, to);
}

describe("provider pin watch", () => {
  test("tags parse only for the component's stable form", () => {
    expect(parseTag("v1.34.1", "v")).toEqual([1, 34, 1]);
    expect(parseTag("docker-v29.9.3", "docker-v")).toEqual([29, 9, 3]);
    expect(parseTag("docker-v29.10.0-rc.1", "docker-v")).toBeNull();
    expect(parseTag("client/v0.6.2", "docker-v")).toBeNull();
    expect(parseTag("v25.0.17", "docker-v")).toBeNull();
    expect(parseTag("v1.34", "v")).toBeNull();
  });

  test("the delta keeps newer stable releases, oldest first", () => {
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
        release("v25.0.17"),
      ]).releases.map((item) => item.tag)
    ).toEqual(["docker-v29.9.3"]);
    expect(() => delta(smolvm, "1.32", [])).toThrow("major.minor.patch");
  });

  test("advisory ranges are read as GitHub writes them", () => {
    const pinned: [number, number, number] = [29, 5, 2];
    expect(inRange(pinned, "< 29.9.3")).toBe(true);
    expect(inRange(pinned, "< 29.5.2")).toBe(false);
    expect(inRange(pinned, "<= 29.5.2")).toBe(true);
    expect(inRange(pinned, ">= 28.0.0, < 29.8.2")).toBe(true);
    expect(inRange(pinned, ">= 29.6.0, < 29.8.2")).toBe(false);
    expect(inRange(pinned, "26.0.0 - 29.8.1")).toBe(true);
    // No version satisfies both: unreadable, never "not affected".
    expect(inRange(pinned, "<= v25.0.18, > v26.0.0")).toBeNull();
    // Lists with spans, wildcards or bare versions are alternatives.
    expect(inRange(pinned, "<= 25.0.18, 26.0.0 - 29.8.1")).toBe(true);
    expect(inRange([28, 2, 7], "28.2.x, 28.3.0, 28.3.1")).toBe(true);
    expect(inRange(pinned, "28.2.x, 28.3.0, 28.3.1")).toBe(false);
    // Partial versions are padded.
    expect(inRange(pinned, ">= v25, < v25.0.2")).toBe(false);
    expect(inRange(pinned, ">= 1.12")).toBe(true);
    expect(inRange(pinned, "<=v2.0.0-beta.28")).toBe(false);
    expect(inRange([0, 34, 1], "<=v0.38.0")).toBe(true);
    expect(inRange([0, 34, 1], ">=0.21.0")).toBe(true);
    expect(inRange(pinned, "= 29.5.2")).toBe(true);
    expect(inRange(pinned, "some versions")).toBeNull();
    expect(inRange(pinned, "N/A")).toBeNull();
    expect(inRange(pinned, "")).toBeNull();
  });

  test("fixed versions the pin has reached clear an open-ended range", () => {
    expect(patched([29, 5, 2], ">= 23.0.3, >= 20.10.24")).toBe(true);
    expect(patched([29, 5, 2], "29.9.3")).toBe(false);
    expect(patched([0, 38, 1], "v0.38.1+")).toBe(true);
    expect(patched([0, 34, 1], "v0.38.1+")).toBe(false);
    expect(patched([29, 5, 2], null)).toBe(false);
    expect(patched([29, 5, 2], "none")).toBe(false);
    // A fix on an older backport line never clears a newer pin.
    expect(patched([29, 5, 2], "v25.0.19", "> v26.0.0")).toBe(false);
    expect(
      affecting(
        [29, 5, 2],
        [advisory("GHSA-hhhh-hhhh-hhhh", "> v26.0.0", "v25.0.19")]
      ).map((entry) => entry.certain)
    ).toEqual([true]);
    // A fix on the pin's own line, or above the range's lower bound, does.
    expect(patched([29, 9, 3], "29.9.3", "< 29.9.3")).toBe(true);
    expect(
      patched([29, 9, 3], "25.0.19, 29.9.3", "<= 25.0.18, 26.0.0 - 29.9.2")
    ).toBe(true);
    // Fixes for several maintained lines: the pin's own line decides.
    const lines = ">= 28.5.1, >= 29.1.1";
    expect(patched([28, 5, 2], lines, ">= 1.12")).toBe(true);
    expect(patched([28, 5, 0], lines, ">= 1.12")).toBe(false);
    expect(patched([29, 0, 9], lines, ">= 1.12")).toBe(false);
    expect(patched([29, 1, 1], lines, ">= 1.12")).toBe(true);
    expect(patched([28, 6, 0], lines, ">= 1.12")).toBe(true);
    expect(patched([27, 9, 9], lines, ">= 1.12")).toBe(false);
    expect(patched([30, 0, 0], lines, ">= 1.12")).toBe(true);
    expect(patched([0, 37, 3], "0.37.2, 0.38.1")).toBe(true);
    expect(patched([0, 36, 0], "0.37.2, 0.38.1")).toBe(false);
    expect(
      affecting([28, 5, 2], [advisory("GHSA-llll-llll-llll", ">= 1.12", lines)])
    ).toEqual([]);
    // Unbounded but fixed long ago: not affecting.
    expect(
      affecting(
        [29, 5, 2],
        [advisory("GHSA-ffff-ffff-ffff", ">= 1.12", ">= 23.0.3, >= 20.10.24")]
      )
    ).toEqual([]);
  });

  test("only advisories whose range contains the pin affect it; unreadable ones are flagged", () => {
    const found = affecting(
      [29, 5, 2],
      [
        advisory("GHSA-aaaa-aaaa-aaaa", "< 29.9.3", "29.9.3"),
        advisory("GHSA-bbbb-bbbb-bbbb", "< 29.5.1", "29.5.1"),
        advisory("GHSA-cccc-cccc-cccc", "not a range"),
        advisory("GHSA-dddd-dddd-dddd", null),
        {
          ...advisory("GHSA-eeee-eeee-eeee", "<= v2.0.0-beta.28"),
          vulnerabilities: [
            {
              vulnerable_version_range: "<= v2.0.0-beta.28",
              patched_versions: "v2.0.0",
            },
            {
              vulnerable_version_range: "< 29.8.2",
              patched_versions: "29.8.2",
            },
          ],
        },
      ]
    );
    expect(
      found.map((entry) => [entry.id, entry.certain, entry.patched])
    ).toEqual([
      ["GHSA-aaaa-aaaa-aaaa", true, "29.9.3"],
      ["GHSA-cccc-cccc-cccc", false, "99.0.0"],
      ["GHSA-dddd-dddd-dddd", false, "99.0.0"],
      ["GHSA-eeee-eeee-eeee", true, "29.8.2"],
    ]);
  });

  test("SmolVM notes are classified by category and interface; other components only by security notes", () => {
    expect(
      classify(smolvm, "Bump libkrunfw to the 6.18 kernel for CVE-2026-98432")
    ).toEqual(["security notes", "libkrun/libkrunfw"]);
    expect(
      classify(smolvm, "Pin libkrun at the vsock muxer guard fix")
    ).toEqual(["libkrun/libkrunfw", "vsock"]);
    expect(classify(smolvm, "Fix a heap vulnerability in the relay")).toEqual([
      "security notes",
    ]);
    expect(
      classify(
        smolvm,
        "Fix --docker-socket forwarding; SMOLVM_IDLE_RECLAIM now 2; machine exec"
      )
    ).toEqual(["`machine exec`", "`--docker-socket`", "`SMOLVM_IDLE_RECLAIM`"]);
    expect(classify(smolvm, "Add --volumes-from and --labels")).toEqual([]);
    // Docker CLI notes mention volumes, labels and disks constantly: not watched there.
    expect(
      classify(docker, "Fix --volume and --label handling on disk templates")
    ).toEqual([]);
    expect(classify(docker, "Fix CVE-2026-0001 in the daemon")).toEqual([
      "security notes",
    ]);
  });

  test("the SmolVM watch list and the runtime source agree in both directions", () => {
    const source = providerSource();
    // Every watched flag, variable and subcommand still appears in the runtime source.
    for (const name of SMOLVM_INTERFACES) {
      const subcommand = /^machine (\w+)$/.exec(name);
      const present = subcommand
        ? new RegExp(`\\[\\s*"machine",\\s*"${subcommand[1]}"`).test(source) ||
          source.includes(`"${subcommand[1]}".into()`)
        : source.includes(`"${name}"`) || source.includes(name);
      expect(present, name).toBe(true);
    }
    // Every flag the runtime passes to the provider, and every SMOLVM_ variable it sets, is
    // watched.
    const lifecycle = readFileSync(join(provider, "lifecycle.rs"), "utf8");
    const passed = [
      between(lifecycle, '"machine".to_owned(),', "create_machine("),
      between(
        readFileSync(join(provider, "network_intent.rs"), "utf8"),
        "fn arguments(",
        "fn same_request("
      ),
      ...[...source.matchAll(/\[\s*"machine",[^\]]*\]/g)].map(
        (match) => match[0]
      ),
    ].join("\n");
    const flags = [...passed.matchAll(/"(--[a-z][a-z-]*)"/g)].map(
      (match) => match[1]
    );
    const subcommands = [...source.matchAll(/\[\s*"machine",\s*"(\w+)"/g)].map(
      (match) => `machine ${match[1]}`
    );
    const variables = [
      ...between(
        lifecycle,
        "fn command(",
        "fn boot_reclamation_policy("
      ).matchAll(/"(SMOLVM_[A-Z_]+)"/g),
    ].map((match) => match[1]);
    expect(flags.length).toBeGreaterThan(10);
    for (const name of [
      ...flags,
      ...subcommands,
      ...variables,
      "machine create",
    ]) {
      expect(
        SMOLVM_INTERFACES,
        `${name} is passed by the runtime but not watched`
      ).toContain(name as string);
    }
  });

  test("upstream text reaches the public issue without mentions, markup or foreign links", () => {
    const ghsa = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
    expect(cell("ping @someone <img src=x> ![x](y) `code` a|b")).not.toMatch(
      /@s|<|>|!\[|`|\|/
    );
    expect(cell("ping @someone")).toContain("@\u200dsomeone");
    expect(cell("fixes #123 and moby/moby#45 see [x](https://e.vil)")).toBe(
      "fixes #\u200d123 and moby/moby#\u200d45 see [x] (https://e.vil)"
    );
    const url =
      "https://github.com/o/r/security/advisories/GHSA-aaaa-bbbb-cccc";
    expect(link("GHSA-aaaa-bbbb-cccc", url, ghsa)).toBe(
      `[GHSA-aaaa-bbbb-cccc](${url})`
    );
    expect(link("GHSA-aaaa-bbbb-cccc", "https://evil.example/x", ghsa)).toBe(
      "GHSA-aaaa-bbbb-cccc"
    );
    expect(link("GHSA-<b>", "https://github.com/x", ghsa)).toBe("GHSA- b ");
  });

  test("the pins file names every watched component", () => {
    const pins = readPins(
      join(repository, "packages/runtime-core/provider-pins.json")
    );
    expect([...pins.keys()]).toEqual(["smolvm", "docker", "buildx"]);
  });

  test("the plan follows releases and advisories, and respects a not-planned close", () => {
    const behind = [
      delta(smolvm, "1.33.0", [
        release("v1.34.1", "Fix GHSA-abcd-1234 in vsock"),
      ]),
    ];
    const advised = [
      delta(
        docker,
        "29.5.2",
        [],
        [advisory("GHSA-aaaa-aaaa-aaaa", "< 29.9.3", "29.9.3")]
      ),
    ];
    const current = [delta(smolvm, "1.34.1", [release("v1.34.1")])];
    const open = { number: 7, state: "open", stateReason: null };
    const closed = { number: 7, state: "closed", stateReason: "completed" };
    const notPlanned = {
      number: 7,
      state: "closed",
      stateReason: "not_planned",
    };
    // A keyword in release notes never sets the security label.
    expect(plan(behind, null, "2026-11-11")).toMatchObject({
      action: "create",
      security: false,
    });
    expect(plan(advised, null, "2026-11-11")).toMatchObject({
      action: "create",
      security: true,
    });
    // An advisory whose range cannot be read is listed, but never sets the label or keeps
    // the issue open on its own.
    const unreadable = [
      delta(docker, "29.5.2", [], [advisory("GHSA-gggg-gggg-gggg", "N/A")]),
    ];
    expect(plan(unreadable, null, "2026-11-11")).toMatchObject({
      action: "none",
      security: false,
    });
    expect(plan(unreadable, open, "2026-11-11").action).toBe("close");
    const unreadBody = renderBody(unreadable, "2026-11-11");
    expect(unreadBody).toContain("range not understood; read it");
    expect(unreadBody).toMatch(/\| 0 \(\+1 to read\) \|$/m);
    expect(plan(behind, closed, "2026-11-11").action).toBe("update");
    expect(plan(behind, notPlanned, "2026-11-11").action).toBe("none");
    expect(plan(advised, notPlanned, "2026-11-11").action).toBe("update");
    expect(plan(current, open, "2026-11-11")).toMatchObject({
      action: "close",
      security: false,
    });
    expect(plan(current, closed, "2026-11-11").action).toBe("none");
    expect(plan(current, null, "2026-11-11").action).toBe("none");
    const body = renderBody([...behind, ...advised], "2026-11-11");
    expect(body).toContain("| SmolVM | 1.33.0 | v1.34.1 | 1 | 0 |");
    expect(body).toContain(
      "| Docker engine | 29.5.2 | docker-v29.5.2 | 0 | 1 |"
    );
    expect(body).toContain(
      "| [GHSA-aaaa-aaaa-aaaa](https://github.com/o/r/security/advisories/GHSA-aaaa-aaaa-aaaa) | high | 29.9.3 |"
    );
    expect(body).toContain(
      "| [v1.34.1](https://github.com/o/r/releases/tag/v1.34.1) | 2026-11-01 | security notes, vsock |"
    );
    const truncated = renderBody(
      [delta(smolvm, "1.0.0", [release("v1.0.1")], [], true)],
      "2026-11-11"
    );
    expect(truncated).toContain("| 1+ |");
    expect(truncated).toContain("stopped at 10 pages");
  });

  test("release paging ignores version order and reports the bound", async () => {
    const pages = new Map<number, Release[]>([
      [
        1,
        [
          release("docker-v28.5.3"),
          ...Array.from({ length: 99 }, (_, i) => release(`api/v1.${i}`)),
        ],
      ],
      [2, [release("docker-v29.9.0"), release("docker-v29.5.2")]],
    ]);
    const requested: number[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      requested.push(page);
      return Response.json(pages.get(page) ?? []);
    }) as typeof fetch;
    const listed = await new GitHub("synthetic", fetcher).releases(docker);
    expect(requested).toEqual([1, 2]);
    expect(listed.truncated).toBe(false);
    expect(
      delta(docker, "29.5.2", listed.releases, []).releases.map(
        (item) => item.tag
      )
    ).toEqual(["docker-v29.9.0"]);

    const full = Array.from({ length: 100 }, () => release("docker-v1.0.0"));
    const endless = (async () =>
      Response.json(full)) as unknown as typeof fetch;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const capped = await new GitHub("synthetic", endless).releases(docker);
      expect(capped.truncated).toBe(true);
      expect(capped.releases).toHaveLength(1000);
    } finally {
      console.warn = warn;
    }
  });

  describe("against a fake GitHub API", () => {
    type Call = { method: string; url: string; body: unknown };
    function fakeApi(options: {
      issues?: Record<string, unknown>[];
      smolvmReleases?: Release[];
      dockerAdvisories?: Advisory[];
    }) {
      const calls: Call[] = [];
      const respond = (method: string, url: string): [number, unknown] => {
        if (method === "HEAD") {
          return [200, null];
        }
        if (url.includes("/repos/smol-machines/smolvm/releases")) {
          return [200, options.smolvmReleases ?? []];
        }
        if (url.includes("/releases")) {
          return [200, []];
        }
        if (url.includes("/repos/moby/moby/security-advisories")) {
          return [200, options.dockerAdvisories ?? []];
        }
        if (url.includes("/security-advisories")) {
          return [200, []];
        }
        if (method === "GET" && url.includes("/repos/owner/repo/issues?")) {
          return [200, options.issues ?? []];
        }
        if (method === "POST" && url.endsWith("/repos/owner/repo/labels")) {
          return [422, { message: "exists" }];
        }
        if (method === "POST" && url.endsWith("/repos/owner/repo/issues")) {
          return [201, { number: 5 }];
        }
        if (method === "PATCH" && /\/issues\/\d+$/.test(url)) {
          return [200, {}];
        }
        if (method === "POST" && /\/issues\/\d+\/labels$/.test(url)) {
          return [200, []];
        }
        if (
          method === "DELETE" &&
          /\/issues\/\d+\/labels\/security$/.test(url)
        ) {
          return [404, { message: "Label does not exist" }];
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
        const [status, value] = respond(method, url);
        if (method === "HEAD") {
          const pin = [
            pinnedManifest.smolvm,
            pinnedManifest.docker,
            pinnedManifest.buildx,
            ...pinnedManifest.network_tools,
          ].find((entry) => entry.url === url);
          if (!pin) {
            throw new Error("Unexpected pinned file.");
          }
          return new Response(null, {
            status,
            headers: { "content-length": String(pin.size_bytes) },
          });
        }
        return new Response(JSON.stringify(value), { status });
      }) as typeof fetch;
      return { calls, fetcher };
    }
    const env = { GITHUB_TOKEN: "synthetic", GITHUB_REPOSITORY: "owner/repo" };
    async function run(api: ReturnType<typeof fakeApi>, argv: string[] = []) {
      const log = console.log;
      const warn = console.warn;
      console.log = () => undefined;
      console.warn = () => undefined;
      try {
        return await main(argv, env, api.fetcher);
      } finally {
        console.log = log;
        console.warn = warn;
      }
    }
    const ours = (state = "open", extra: Record<string, unknown> = {}) => ({
      number: 9,
      title: ISSUE_TITLE,
      state,
      state_reason: state === "closed" ? "completed" : null,
      user: { login: BOT_LOGIN },
      labels: [{ name: WATCH_LABEL }],
      ...extra,
    });
    const behind = [release("v99.0.0", "Fix --mount-socket framing")];
    const writes = (calls: Call[]) =>
      calls.filter((call) => call.method !== "GET" && call.method !== "HEAD");

    test("the lookup asks for the watch label and the bot, and a dry run writes nothing", async () => {
      const api = fakeApi({ smolvmReleases: behind });
      expect(await run(api, ["--dry-run"])).toBe(0);
      expect(writes(api.calls)).toEqual([]);
      const lookup = api.calls.find((call) =>
        call.url.includes("/repos/owner/repo/issues?")
      );
      expect(lookup?.url).toContain(`labels=${WATCH_LABEL}`);
      expect(lookup?.url).toContain(`creator=${encodeURIComponent(BOT_LOGIN)}`);
    });

    test("a new issue carries the watch label, and security only for an advisory", async () => {
      const plain = fakeApi({ smolvmReleases: behind });
      expect(await run(plain)).toBe(0);
      const created = plain.calls.find(
        (call) =>
          call.method === "POST" &&
          call.url.endsWith("/repos/owner/repo/issues")
      );
      expect(created?.body).toMatchObject({
        title: ISSUE_TITLE,
        labels: [WATCH_LABEL],
      });

      const advised = fakeApi({
        dockerAdvisories: [
          advisory("GHSA-aaaa-aaaa-aaaa", "< 29.9.3", "29.9.3"),
        ],
      });
      expect(await run(advised)).toBe(0);
      const createdSecure = advised.calls.find(
        (call) =>
          call.method === "POST" &&
          call.url.endsWith("/repos/owner/repo/issues")
      );
      expect(createdSecure?.body).toMatchObject({
        labels: [WATCH_LABEL, "security"],
      });
      expect(String((createdSecure?.body as { body: string }).body)).toContain(
        "GHSA-aaaa-aaaa-aaaa"
      );
    });

    test("an update keeps other labels: security is added or removed on its own", async () => {
      const advised = fakeApi({
        issues: [ours()],
        dockerAdvisories: [
          advisory("GHSA-aaaa-aaaa-aaaa", "< 29.9.3", "29.9.3"),
        ],
      });
      expect(await run(advised)).toBe(0);
      expect(
        writes(advised.calls).map((call) => [
          call.method,
          call.url.split("/repos/owner/repo")[1],
          call.body,
        ])
      ).toEqual([
        ["POST", "/labels", expect.objectContaining({ name: WATCH_LABEL })],
        ["POST", "/labels", expect.objectContaining({ name: "security" })],
        [
          "PATCH",
          "/issues/9",
          expect.not.objectContaining({ labels: expect.anything() }),
        ],
        ["POST", "/issues/9/labels", { labels: ["security"] }],
      ]);

      const cleared = fakeApi({ issues: [ours()], smolvmReleases: behind });
      expect(await run(cleared)).toBe(0);
      const last = writes(cleared.calls).at(-1);
      expect(last?.method).toBe("DELETE");
      expect(last?.url).toEndWith("/issues/9/labels/security");
    });

    test("a current pin closes the open issue and clears the security label", async () => {
      const api = fakeApi({ issues: [ours()] });
      expect(await run(api)).toBe(0);
      const patch = writes(api.calls).find((call) => call.method === "PATCH");
      expect(patch?.body).toMatchObject({
        state: "closed",
        state_reason: "completed",
      });
      expect(writes(api.calls).at(-1)?.method).toBe("DELETE");
    });

    test("an issue someone else opened is never adopted", async () => {
      const api = fakeApi({
        issues: [ours("open", { user: { login: "someone" } })],
        smolvmReleases: behind,
      });
      expect(await run(api)).toBe(0);
      expect(
        writes(api.calls).some(
          (call) =>
            call.method === "POST" &&
            call.url.endsWith("/repos/owner/repo/issues")
        )
      ).toBe(true);
      expect(
        writes(api.calls).some((call) => call.url.includes("/issues/9"))
      ).toBe(false);
    });

    test("an advisory reopens a not-planned issue and adds the security label", async () => {
      const api = fakeApi({
        issues: [ours("closed", { state_reason: "not_planned" })],
        dockerAdvisories: [
          advisory("GHSA-aaaa-aaaa-aaaa", "< 29.9.3", "29.9.3"),
        ],
      });
      expect(await run(api)).toBe(0);
      const issueWrites = writes(api.calls).filter((call) =>
        call.url.includes("/issues/9")
      );
      expect(issueWrites.map((call) => [call.method, call.body])).toEqual([
        ["PATCH", expect.objectContaining({ state: "open" })],
        ["POST", { labels: ["security"] }],
      ]);
    });

    test("a not-planned close stays closed without an advisory", async () => {
      const api = fakeApi({
        issues: [ours("closed", { state_reason: "not_planned" })],
        smolvmReleases: behind,
      });
      expect(await run(api)).toBe(0);
      expect(writes(api.calls)).toEqual([]);
    });

    test("bad input is refused before any request", async () => {
      const api = fakeApi({});
      const error = console.error;
      console.error = () => undefined;
      try {
        expect(
          await main(
            [],
            { GITHUB_TOKEN: "x", GITHUB_REPOSITORY: "bad repo" },
            api.fetcher
          )
        ).toBe(64);
      } finally {
        console.error = error;
      }
      expect(api.calls).toEqual([]);
    });
  });
});

describe("pinned download availability", () => {
  test("every archive and guest URL is checked without a token, with bounded redirects", async () => {
    const files = readPinnedFiles(
      join(repository, "packages/runtime-core/provider-pins.json")
    );
    expect(files).toHaveLength(7);
    const observed: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.method).toBe("HEAD");
        expect(request.headers.has("authorization")).toBe(false);
        const path = new URL(request.url).pathname;
        observed.push(path);
        if (path === "/redirect") {
          return Response.redirect("https://mirror.test/final", 302);
        }
        if (path === "/retired") {
          return new Response(null, { status: 410 });
        }
        if (path === "/missing") {
          return new Response(null, { status: 404 });
        }
        if (path === "/foreign") {
          return Response.redirect("https://unlisted.test/final", 302);
        }
        if (path === "/downgrade") {
          return Response.redirect("http://source.test/final", 302);
        }
        if (path === "/loop") {
          return new Response(null, {
            status: 302,
            headers: { location: "/loop" },
          });
        }
        const pin = files.find((entry) => new URL(entry.url).pathname === path);
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(pin?.sizeBytes ?? 5) },
        });
      },
    });
    const fetcher = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(
        new URL(new URL(String(input)).pathname, server.url),
        init
      )) as typeof fetch;
    try {
      const available = await checkPinnedUrls(files, fetcher);
      expect(available.every((entry) => entry.problem === null)).toBe(true);
      expect(observed).toHaveLength(7);
      const checks = await checkPinnedUrls(
        ["redirect", "retired", "missing", "foreign", "downgrade", "loop"].map(
          (path) => ({
            url: `https://source.test/${path}`,
            redirectHosts: ["mirror.test"],
            sizeBytes: 5,
          })
        ),
        fetcher
      );
      expect(checks.map((entry) => entry.problem)).toEqual([
        null,
        "HTTP 410: upstream no longer serves this pinned file",
        "HTTP 404: upstream no longer serves this pinned file",
        "redirect refused (host or scheme not pinned)",
        "redirect refused (host or scheme not pinned)",
        "redirect missing or limit exceeded",
      ]);
      expect(observed.filter((path) => path === "/loop")).toHaveLength(6);
      const failed = checks.filter((entry) => entry.problem !== null);
      const current = [delta(smolvm, "1.34.1", [])];
      expect(plan(current, null, "2026-11-12", failed)).toMatchObject({
        action: "create",
        security: false,
      });
      expect(
        plan(
          current,
          { number: 7, state: "closed", stateReason: "not_planned" },
          "2026-11-12",
          failed
        ).action
      ).toBe("update");
      expect(renderBody(current, "2026-11-12", checks)).toContain(
        "Pinned download availability"
      );
    } finally {
      server.stop(true);
    }
  });
});

function firstByte(total: number): Response {
  return new Response("x", {
    status: 206,
    headers: {
      "content-range": `bytes 0-0/${total}`,
      "content-length": "1",
    },
  });
}

test("HEAD length and failure kinds distinguish broken pins from transient failures", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        expect(path).toBe("/wrong");
        expect(request.headers.get("range")).toBe("bytes=0-0");
        return firstByte(6);
      }
      if (path === "/gone") {
        return new Response(null, { status: 410 });
      }
      if (path === "/missing") {
        return new Response(null, { status: 404 });
      }
      if (path === "/busy") {
        return new Response(null, { status: 503 });
      }
      return new Response(null, {
        status: 200,
        headers: { "content-length": path === "/wrong" ? "6" : "5" },
      });
    },
  });
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/timeout") {
      throw new DOMException("synthetic timeout", "TimeoutError");
    }
    return fetch(new URL(url.pathname, server.url), init);
  }) as typeof fetch;
  try {
    const checks = await checkPinnedUrls(
      ["good", "wrong", "gone", "missing", "busy", "timeout"].map((path) => ({
        url: `https://source.test/${path}`,
        sizeBytes: 5,
        redirectHosts: [],
      })),
      fetcher
    );
    expect(checks.map((file) => file.kind)).toEqual([
      "available",
      "invalid",
      "no_longer_served",
      "no_longer_served",
      "transient",
      "transient",
    ]);
    expect(checks[1]?.problem).toContain(
      "Content-Length differs from pinned size_bytes (5)"
    );
    const current = [delta(smolvm, "1.34.1", [])];
    const invalid = checks.filter((entry) => entry.kind === "invalid");
    expect(invalid).toHaveLength(1);
    expect(
      plan(
        current,
        { number: 7, state: "closed", stateReason: "not_planned" },
        "2026-11-12",
        invalid
      ).action
    ).toBe("none");
    for (const check of checks.filter((entry) => entry.kind === "transient")) {
      expect(check.problem).not.toContain("no longer serves");
      for (const stateReason of ["completed", "not_planned"]) {
        expect(
          plan(
            current,
            { number: 7, state: "closed", stateReason },
            "2026-11-12",
            [check]
          ).action
        ).toBe("none");
      }
      expect(plan(current, null, "2026-11-12", [check]).action).toBe("none");
      expect(
        plan(
          current,
          { number: 7, state: "open", stateReason: null },
          "2026-11-12",
          [check]
        ).action
      ).toBe("update");
    }
    for (const check of checks.filter(
      (entry) => entry.kind === "no_longer_served"
    )) {
      expect(
        plan(
          current,
          { number: 7, state: "closed", stateReason: "not_planned" },
          "2026-11-12",
          [check]
        ).action
      ).toBe("update");
    }
  } finally {
    server.stop(true);
  }
});

test("a HEAD length disagreement must repeat before it can reopen an issue", async () => {
  const counts = new Map<string, number>();
  const signals = new Map<string, AbortSignal[]>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.has("authorization")).toBe(false);
      const path = new URL(request.url).pathname;
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      expect(request.method).toBe(count === 1 ? "HEAD" : "GET");
      if (count === 2) {
        expect(request.headers.get("cache-control")).toBe("no-cache");
        expect(request.headers.get("range")).toBe("bytes=0-0");
        expect(request.headers.get("accept-encoding")).toBe("identity");
        if (path === "/fails") {
          return new Response(null, { status: 503 });
        }
      }
      if (count === 1) {
        return new Response(null, { headers: { "content-length": "6" } });
      }
      return firstByte(path === "/repeats" ? 6 : path === "/changes" ? 7 : 5);
    },
  });
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const seen = signals.get(path) ?? [];
    if (init?.signal) {
      seen.push(init.signal);
    }
    signals.set(path, seen);
    return fetch(new URL(path, server.url), init);
  }) as typeof fetch;
  try {
    const checks = await checkPinnedUrls(
      ["recovers", "changes", "fails", "repeats"].map((name) => ({
        url: `https://source.test/${name}`,
        sizeBytes: 5,
        redirectHosts: [],
      })),
      fetcher
    );
    expect(checks.map((entry) => entry.kind)).toEqual([
      "available",
      "transient",
      "transient",
      "invalid",
    ]);
    const current = [delta(smolvm, "1.34.1", [])];
    for (const [index, check] of checks.entries()) {
      expect(counts.get(`/${check.name}`)).toBe(2);
      const seen = signals.get(`/${check.name}`);
      expect(seen).toHaveLength(2);
      expect(seen?.[0]).toBe(seen?.[1]);
      expect(
        plan(
          current,
          { number: 7, state: "closed", stateReason: "completed" },
          "2026-11-12",
          [check]
        ).action
      ).toBe(index === 3 ? "update" : "none");
    }
    expect(checks[3]?.problem).toContain("confirmed by one-byte GET");
  } finally {
    server.stop(true);
  }
});

test("unsuccessful length confirmations cannot create or reopen an issue", async () => {
  const observed = new Map<string, number>();
  const attempts = new Map<string, number>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.has("authorization")).toBe(false);
      const path = new URL(request.url).pathname;
      const count = (observed.get(path) ?? 0) + 1;
      observed.set(path, count);
      expect(request.method).toBe(count === 1 ? "HEAD" : "GET");
      if (count === 1) {
        return new Response(null, { headers: { "content-length": "6" } });
      }
      expect(request.headers.get("cache-control")).toBe("no-cache");
      expect(request.headers.get("range")).toBe("bytes=0-0");
      if (path === "/gone" || path === "/retired") {
        return new Response(null, { status: path === "/gone" ? 404 : 410 });
      }
      if (path === "/foreign") {
        return Response.redirect("https://unlisted.test/file", 302);
      }
      return new Response(null, {
        status: 302,
        headers: path === "/loop" ? { location: "/loop" } : {},
      });
    },
  });
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe("source.test"); // no refused redirect reaches the wire
    const count = (attempts.get(url.pathname) ?? 0) + 1;
    attempts.set(url.pathname, count);
    if (url.pathname === "/timeout" && count === 2) {
      throw new DOMException("synthetic timeout", "TimeoutError");
    }
    return fetch(new URL(url.pathname, server.url), init);
  }) as typeof fetch;
  try {
    const checks = await checkPinnedUrls(
      ["gone", "retired", "foreign", "missing-redirect", "loop", "timeout"].map(
        (name) => ({
          url: `https://source.test/${name}`,
          sizeBytes: 5,
          redirectHosts: [],
        })
      ),
      fetcher
    );
    expect(checks).toHaveLength(6);
    const current = [delta(smolvm, "1.34.1", [])];
    for (const check of checks) {
      expect(check.kind).toBe("transient");
      expect(check.problem).not.toContain("upstream no longer serves");
      expect(attempts.get(`/${check.name}`)).toBe(
        check.name === "loop" ? 7 : 2
      );
      expect(plan(current, null, "2026-11-12", [check]).action).toBe("none");
      for (const stateReason of ["completed", "not_planned"]) {
        expect(
          plan(
            current,
            { number: 7, state: "closed", stateReason },
            "2026-11-12",
            [check]
          ).action
        ).toBe("none");
      }
      expect(
        plan(
          current,
          { number: 7, state: "open", stateReason: null },
          "2026-11-12",
          [check]
        ).action
      ).toBe("update");
    }
  } finally {
    server.stop(true);
  }
});

test("one-byte confirmation refuses ignored ranges, bad framing and incomplete bodies", async () => {
  const paths = [
    "ignored",
    "bad-range",
    "missing-range",
    "missing-length",
    "encoding",
    "empty",
    "extra",
  ];
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push(`${request.method} ${path}`);
      if (request.method === "HEAD") {
        return new Response(null, { headers: { "content-length": "6" } });
      }
      expect(request.headers.get("range")).toBe("bytes=0-0");
      if (path === "/ignored") {
        return new Response("ignore", { status: 200 });
      }
      const response = firstByte(6);
      if (path === "/bad-range") {
        response.headers.set("content-range", "bytes 1-1/6");
      }
      if (path === "/missing-range") {
        response.headers.delete("content-range");
      }
      if (path === "/missing-length") {
        response.headers.delete("content-length");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x"));
              controller.close();
            },
          }),
          { status: 206, headers: response.headers }
        );
      }
      return response;
    },
  });
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const path = new URL(String(input)).pathname;
    const response = await fetch(new URL(path, server.url), init);
    if (
      init?.method === "GET" &&
      ["/missing-length", "/encoding"].includes(path)
    ) {
      const headers = new Headers(response.headers);
      if (path === "/encoding") {
        headers.set("content-encoding", "gzip");
      } else {
        headers.delete("content-length");
      }
      return new Response(response.body, { status: 206, headers });
    }
    if (init?.method === "GET" && ["/empty", "/extra"].includes(path)) {
      // The HTTP server frames Content-Length correctly. This transport seam
      // also exercises a response whose delivered bytes contradict its header.
      await response.body?.cancel();
      return new Response(path === "/empty" ? "" : "xx", {
        status: 206,
        headers: response.headers,
      });
    }
    return response;
  }) as typeof fetch;
  try {
    const checks = await checkPinnedUrls(
      paths.map((name) => ({
        url: new URL(name, "https://source.test/").href,
        sizeBytes: 5,
        redirectHosts: [],
      })),
      fetcher
    );
    expect(checks).toHaveLength(paths.length);
    for (const check of checks) {
      expect({ name: check.name, kind: check.kind }).toEqual({
        name: check.name,
        kind: "transient",
      });
      expect(
        plan(
          [delta(smolvm, "1.34.1", [])],
          {
            number: 7,
            state: "closed",
            stateReason: "completed",
          },
          "2026-11-13",
          [check]
        ).action
      ).toBe("none");
    }
    expect(seen).toHaveLength(paths.length * 2);
  } finally {
    server.stop(true);
  }
});

test("only a decimal HEAD length can corroborate a changed GET total", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.method).toBe("GET");
      return firstByte(6);
    },
  });
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "HEAD") {
      // Malformed header values cannot corroborate a size even if Number()
      // would coerce them; keep the transport boundary defensive.
      const response = new Response(null, {
        headers: { "content-length": path.slice(1) },
      });
      expect(response.headers.get("content-length")).toBe(path.slice(1));
      return response;
    }
    return fetch(new URL(path, server.url), init);
  }) as typeof fetch;
  try {
    const checks = await checkPinnedUrls(
      ["0x6", "6e0", "6.0", "6"].map((value) => ({
        url: new URL(value, "https://source.test/").href,
        sizeBytes: 5,
        redirectHosts: [],
      })),
      fetcher
    );
    expect(checks.map((entry) => entry.kind)).toEqual([
      "transient",
      "transient",
      "transient",
      "invalid",
    ]);
  } finally {
    server.stop(true);
  }
});
