import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  activeFields,
  BLOB_SHA256,
  compose,
  contentDigest,
  DEPENDENCY_SERVER,
  INERT_RECORD_FIELDS,
  INERT_RUNNING_RESOURCES,
  inertField,
  main,
  parseCpuTime,
  parseFootprint,
  parseOptions,
  parseProcessRows,
  parseTopMemory,
  providerProcesses,
  readyData,
  rootProblem,
  sourceTemplatePins,
  warmPhases,
} from "../scripts/qualify-provider-pin.ts";

const repository = resolve(import.meta.dir, "..");
const digest = `sha256:${"a".repeat(64)}`;
const required = [
  "--hack",
  "/bundle/hack-v5",
  "--home",
  "/private/tmp/qualification",
  "--provider-archive",
  "/inputs/smolvm.tar.gz",
  "--engine-archive",
  "/inputs/docker.tgz",
  "--network-tools",
  "/inputs/apks",
  "--web-image",
  `busybox@${digest}`,
  "--db-image",
  `postgres@${digest}`,
];

function rustList(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}:`);
  const body = source.slice(start, source.indexOf("];", start));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] as string);
}

/** An independent, unoptimized statement of `disk_template::content_digest`. */
function referenceDigest(bytes: Uint8Array): string {
  const hash = createHash("sha256");
  const le = (value: number) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  };
  hash.update("hack.disk-template.content.v1\0");
  hash.update(le(4096));
  hash.update(le(bytes.length));
  for (let index = 0; index * 4096 < bytes.length; index++) {
    const block = bytes.subarray(index * 4096, (index + 1) * 4096);
    if (block.some((byte) => byte !== 0)) {
      hash.update(le(index));
      hash.update(block);
    }
  }
  return hash.digest("hex");
}

describe("provider pin qualification", () => {
  test("arguments are absolute, images pinned, and the bundle executor is adjacent", () => {
    const options = parseOptions(required);
    expect(options.native).toBe("/bundle/hack-native");
    expect(options.bundle).toBe("/bundle");
    expect(options.idleMinutes).toEqual([0, 3, 10]);
    expect(options.approvedHosts).toEqual(["example.com", "example.org"]);
    expect(options.run).toBe(false);
    expect(
      parseOptions([...required, "--skip-idle", "--run"]).idleMinutes
    ).toEqual([]);
    for (const [flag, value] of [
      ["--home", "relative/root"],
      ["--web-image", "busybox:latest"],
      ["--idle-minutes", "2,0"],
      ["--https-port", "80"],
      ["--approved-host", "not a host"],
    ] as const) {
      const argv = [...required];
      const index = argv.indexOf(flag);
      if (index >= 0) {
        argv[index + 1] = value;
      } else {
        argv.push(flag, value);
      }
      expect(() => parseOptions(argv)).toThrow();
    }
    expect(() => parseOptions(required.slice(2))).toThrow("--hack");
    expect(() => parseOptions([...required, "--caddy", "/bin/caddy"])).toThrow(
      "go together"
    );
  });

  test("a preview changes nothing and a run refuses off Apple Silicon macOS", async () => {
    const root = mkdtempSync(join(tmpdir(), "hack-qualify-preview-"));
    try {
      const argv = required.map((value) =>
        value === "/private/tmp/qualification" ? join(root, "absent") : value
      );
      expect(await main(argv)).toBe(0);
      if (process.platform !== "darwin" || process.arch !== "arm64") {
        expect(await main([...argv, "--run"])).toBe(64);
      }
      expect(await main(["--hack"])).toBe(64);
      expect(Bun.spawnSync(["ls", "-A", root]).stdout.toString()).toBe("");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test("the root must not break the provider database URI", () => {
    expect(rootProblem("/private/tmp/a?b")).toMatch(/must not contain/);
    expect(rootProblem("/private/tmp/qualification-absent")).toMatch(
      /must exist/
    );
  });

  test("inert field lists and rule match the runtime audit", () => {
    const audit = readFileSync(
      join(repository, "packages/runtime-core/src/provider/config_audit.rs"),
      "utf8"
    );
    expect<string[]>([...INERT_RECORD_FIELDS]).toEqual(
      rustList(audit, "INERT_RECORD_FIELDS")
    );
    expect<string[]>([...INERT_RUNNING_RESOURCES]).toEqual(
      rustList(audit, "INERT_RUNNING_RESOURCES")
    );
    for (const value of [undefined, null, false, [], {}]) {
      expect(inertField("disks", value)).toBe(true);
    }
    for (const value of [true, "x", ["x"], { a: 1 }, 0]) {
      expect(inertField("disks", value)).toBe(false);
    }
    expect(inertField("block_private", [])).toBe(false);
    expect(inertField("block_private", null)).toBe(true);
    expect(
      activeFields({ disks: [], egress_rules: [{}], nested_virt: true }, [
        "disks",
        "egress_rules",
        "nested_virt",
      ])
    ).toEqual(["egress_rules", "nested_virt"]);
  });

  test("the content digest elides holes and zero blocks and matches the reference", () => {
    const root = mkdtempSync(join(tmpdir(), "hack-qualify-digest-"));
    try {
      const length = 5 * 4096 + 100;
      const bytes = new Uint8Array(length);
      bytes.set([1, 2, 3], 4096 * 2 + 7);
      bytes.set([9], length - 1);
      const sparse = join(root, "sparse");
      const dense = join(root, "dense");
      let descriptor = openSync(sparse, "w");
      ftruncateSync(descriptor, length);
      writeSync(
        descriptor,
        bytes.subarray(4096 * 2, 4096 * 3),
        0,
        4096,
        4096 * 2
      );
      writeSync(descriptor, bytes.subarray(length - 1), 0, 1, length - 1);
      closeSync(descriptor);
      descriptor = openSync(dense, "w");
      writeSync(descriptor, bytes);
      closeSync(descriptor);
      const expected = referenceDigest(bytes);
      expect(contentDigest(sparse)).toEqual({ sha256: expected, length });
      expect(contentDigest(dense)).toEqual({ sha256: expected, length });
      bytes[0] = 1;
      expect(referenceDigest(bytes)).not.toBe(expected);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test("template pins are read from the runtime source for the published archive", () => {
    const source = readFileSync(
      join(repository, "packages/runtime-core/src/provider/disk_template.rs"),
      "utf8"
    );
    const pins = JSON.parse(
      readFileSync(
        join(repository, "packages/runtime-core/provider-pins.json"),
        "utf8"
      )
    );
    const parsed = sourceTemplatePins(source);
    expect(parsed?.archive).toBe(pins.smolvm.archive_sha256);
    expect(Object.keys(parsed?.templates ?? {}).sort()).toEqual([
      "overlay-template.ext4",
      "storage-template.ext4",
    ]);
    expect(sourceTemplatePins("no pins here")).toBeNull();
  });

  test("process and memory observations parse their macOS formats", () => {
    expect(
      parseFootprint(
        "smolvm-bin [123]: 64-bit    Footprint: 412 MB (16384 bytes per page)"
      )
    ).toBe(412 * 1024 * 1024);
    expect(parseFootprint("Footprint: 1.5 GB")).toBe(1.5 * 1024 ** 3);
    expect(parseFootprint("no footprint")).toBeNull();
    expect(parseTopMemory("PID    MEM\n123    845M+\n", 123)).toBe(
      845 * 1024 ** 2
    );
    expect(parseTopMemory("PID    MEM\n124    845M\n", 123)).toBeNull();
    expect(parseCpuTime("0:01.50")).toBe(1.5);
    expect(parseCpuTime("1:02:03.00")).toBe(3723);
    expect(parseCpuTime("2-00:00:01")).toBe(172_801);
    expect(parseCpuTime("bad")).toBeNull();
    const rows = parseProcessRows(
      [
        "  10     1  2048   0:01.00 /private/tmp/q/candidate/.hack-local/providers/smolvm-1.34.1-darwin-arm64/smolvm-bin _boot-vm",
        "  11     1  1024   0:00.10 /usr/bin/other --flag",
        "garbage",
      ].join("\n")
    );
    expect(rows.map((row) => row.pid)).toEqual([10, 11]);
    expect(
      providerProcesses(
        rows,
        "/private/tmp/q/candidate/.hack-local/providers"
      ).map((row) => row.pid)
    ).toEqual([10]);
  });

  test("warm up -d phases come from executor process lifetimes", () => {
    const native = "/bundle/hack-native";
    const sample = (at: number, ...commands: string[]) => ({
      at,
      commands: commands.map(
        (command) => `${native} --candidate-root /h ${command}`
      ),
    });
    const phases = warmPhases(
      [
        sample(0.05),
        sample(0.6, "graph retained-preflight --run-id x --json"),
        sample(1.2, "graph retained-preflight --run-id x --json"),
        sample(1.3),
        sample(1.4, "runtime up --profile development --json"),
        sample(7.3, "runtime up --profile development --json"),
        sample(7.4, "runtime status --json"),
        sample(9.9, "graph serve --run-id x"),
      ],
      11.1
    );
    expect(phases).toEqual({
      launcher_to_preflight_s: 0.6,
      retained_preflight_s: 0.6,
      preflight_to_runtime_up_s: 0.2,
      runtime_up_s: 5.9,
      serve_to_ready_s: 3.8,
      total_s: 11.1,
    });
    // A phase never observed is unknown, not zero.
    expect(warmPhases([sample(0.1)], 2).runtime_up_s).toBeNull();
    expect(
      parseOptions([...required, "--warm-runs", "3", "--warm-only"])
    ).toMatchObject({
      warmRuns: 3,
      warmOnly: true,
    });
    expect(parseOptions(required).warmRuns).toBe(5);
    expect(() => parseOptions([...required, "--warm-runs", "21"])).toThrow(
      "warm-runs"
    );
  });

  test("readiness requires an observed ready run", () => {
    const ready = { status: "observed", phase: "ready-observed", items: [] };
    expect(readyData(JSON.stringify({ ok: true, data: ready }))).toEqual(ready);
    expect(
      readyData(
        JSON.stringify({ ok: true, data: { ...ready, phase: "starting" } })
      )
    ).toBeNull();
    expect(readyData(JSON.stringify({ ok: false, data: ready }))).toBeNull();
    expect(readyData("not json")).toBeNull();
  });

  test("the fixture declares the dependency alias, a named volume and the listener body", () => {
    const text = compose(`busybox@${digest}`, `postgres@${digest}`, "dep.test");
    expect(text).toContain('"dep.test:host-gateway"');
    expect(text).toContain('"db-data:/var/lib/postgresql/data"');
    expect(DEPENDENCY_SERVER).toContain('hostname: "127.0.0.1"');
    // The listener serves the bytes the guest check hashes: i % 251 over 64 KiB.
    expect(DEPENDENCY_SERVER).toContain(
      "new Uint8Array(65536).map((_, i) => i % 251)"
    );
    expect(BLOB_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
