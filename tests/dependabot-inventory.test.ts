import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REPOSITORY,
  type GhRunner,
  InventoryError,
  listOpenAlerts,
  normalizeAlert,
  parseInventoryArguments,
  renderInventory,
  runInventory,
} from "../scripts/dependabot-inventory.ts";

function alert(opts: {
  readonly number: number;
  readonly name: string;
  readonly severity: string;
  readonly manifest: string;
  readonly fixedIn: string | null;
  readonly state?: string;
}): Record<string, unknown> {
  return {
    number: opts.number,
    state: opts.state ?? "open",
    dependency: {
      manifest_path: opts.manifest,
      package: { ecosystem: "npm", name: opts.name },
    },
    security_advisory: {
      ghsa_id: `GHSA-test-${opts.number}`,
      severity: opts.severity,
    },
    security_vulnerability: {
      severity: opts.severity,
      vulnerable_version_range: "< 9.9.9",
      first_patched_version:
        opts.fixedIn === null ? null : { identifier: opts.fixedIn },
    },
  };
}

function stubGh(lines: readonly unknown[]): {
  readonly gh: GhRunner;
  readonly calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args) => {
      calls.push([...args]);
      return Promise.resolve(
        `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
      );
    },
  };
}

describe("dependabot inventory", () => {
  test("lists open alerts with GET-only paginated gh api calls", async () => {
    const { gh, calls } = stubGh([
      alert({
        number: 2,
        name: "drizzle-orm",
        severity: "high",
        manifest: "packages/db/package.json",
        fixedIn: "0.45.2",
      }),
      alert({
        number: 1,
        name: "next",
        severity: "critical",
        manifest: "examples/next-app/package.json",
        fixedIn: "16.3.3",
      }),
      alert({
        number: 3,
        name: "left-pad",
        severity: "low",
        manifest: "package.json",
        fixedIn: null,
      }),
      alert({
        number: 4,
        name: "fixed-already",
        severity: "high",
        manifest: "package.json",
        fixedIn: "1.0.0",
        state: "fixed",
      }),
    ]);

    const alerts = await listOpenAlerts({ repository: DEFAULT_REPOSITORY, gh });

    expect(calls).toHaveLength(1);
    const args = calls[0] ?? [];
    expect(args.slice(0, 4)).toEqual(["api", "--method", "GET", "--paginate"]);
    expect(args).not.toContain("POST");
    expect(args).not.toContain("PATCH");
    expect(args.at(-1)).toBe(
      "repos/hack-dance/hack/dependabot/alerts?state=open&per_page=100"
    );
    expect(
      alerts.map((entry) => [
        entry.number,
        entry.severity,
        entry.package,
        entry.manifest,
        entry.fixedIn,
      ])
    ).toEqual([
      [1, "critical", "next", "examples/next-app/package.json", "16.3.3"],
      [2, "high", "drizzle-orm", "packages/db/package.json", "0.45.2"],
      [3, "low", "left-pad", "package.json", null],
    ]);

    const text = renderInventory({ repository: DEFAULT_REPOSITORY, alerts });
    expect(text).toContain(
      "Open Dependabot alerts for hack-dance/hack: 3 (critical=1 high=1 medium=0 low=1 unknown=0)"
    );
    expect(text).toContain("fixed-in");
    expect(text).toContain("no fix");
  });

  test("renders JSON through the injected writer without touching files", async () => {
    const { gh } = stubGh([
      alert({
        number: 7,
        name: "next",
        severity: "medium",
        manifest: "examples/next-app/package.json",
        fixedIn: "16.2.11",
      }),
    ]);
    const output: string[] = [];

    const code = await runInventory({
      argv: ["--json", "--repo", "octo-org/example.repo"],
      gh,
      write: (text) => output.push(text),
    });

    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(output.join(""));
    expect(parsed).toEqual({
      repository: "octo-org/example.repo",
      alerts: [
        {
          number: 7,
          ecosystem: "npm",
          package: "next",
          severity: "medium",
          manifest: "examples/next-app/package.json",
          vulnerableRange: "< 9.9.9",
          fixedIn: "16.2.11",
          advisory: "GHSA-test-7",
        },
      ],
    });
  });

  test("an empty inventory reports zero alerts", () => {
    expect(renderInventory({ repository: "a/b", alerts: [] })).toBe(
      "Open Dependabot alerts for a/b: 0 (critical=0 high=0 medium=0 low=0 unknown=0)\n"
    );
  });

  test("unprintable GitHub text is replaced, never echoed", () => {
    const normalized = normalizeAlert(
      alert({
        number: 9,
        name: "evil\u001b[2Jpkg",
        severity: "bogus",
        manifest: "a\nb",
        fixedIn: "1.0.0\u0007",
      })
    );
    expect(normalized).toEqual({
      number: 9,
      ecosystem: "npm",
      package: "<unprintable>",
      severity: "unknown",
      manifest: "<unprintable>",
      vulnerableRange: "< 9.9.9",
      fixedIn: null,
      advisory: "GHSA-test-9",
    });
    expect(normalizeAlert({ state: "open" })).toBeNull();
    expect(normalizeAlert("not an object")).toBeNull();
  });

  test("refusals are closed and never echo input or gh output", async () => {
    const hostile = "owner/repo;$(touch /tmp/pwned)";
    expect(() => parseInventoryArguments(["--repo", hostile])).toThrow(
      new InventoryError("Invalid --repo value (expected owner/name)")
    );
    expect(() => parseInventoryArguments(["--token", "ghp_secret"])).toThrow(
      new InventoryError("Unknown argument")
    );
    expect(() => parseInventoryArguments(["--repo"])).toThrow(InventoryError);

    const failing: GhRunner = () =>
      Promise.reject(new Error("HTTP 403: secret-bearing gh stderr"));
    const failure = await listOpenAlerts({
      repository: DEFAULT_REPOSITORY,
      gh: failing,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InventoryError);
    expect((failure as Error).message).not.toContain("secret-bearing");

    const garbage: GhRunner = () => Promise.resolve("{not json\n");
    await expect(
      listOpenAlerts({ repository: DEFAULT_REPOSITORY, gh: garbage })
    ).rejects.toThrow(new InventoryError("Unexpected GitHub response"));
  });

  test("help prints usage without calling gh", async () => {
    const { gh, calls } = stubGh([]);
    const output: string[] = [];
    expect(
      await runInventory({
        argv: ["--help"],
        gh,
        write: (text) => output.push(text),
      })
    ).toBe(0);
    expect(calls).toHaveLength(0);
    expect(output.join("")).toContain("Usage:");
  });
});
