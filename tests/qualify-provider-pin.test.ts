import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
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
  foregroundReadyRun,
  INERT_RECORD_FIELDS,
  INERT_RUNNING_RESOURCES,
  inertField,
  main,
  type Options,
  parseCpuTime,
  parseFootprint,
  parseOptions,
  parseProcessRows,
  parseTopMemory,
  providerProcesses,
  Qualification,
  qualificationInputSizes,
  readJson,
  readyData,
  rootProblem,
  sourceTemplatePins,
  terminalRuntimeErrorCode,
} from "../scripts/qualify-provider-pin.ts";
import { formatNativeStartupLogReport } from "../src/backends/native-startup-logs.ts";
import { selectNativeComposeProject } from "../src/lib/native-compose-selection.ts";

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
  "--builder-archive",
  "/inputs/buildx",
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
    expect(parseOptions(required)).toMatchObject({
      profile: "development",
      keepGoing: false,
    });
    expect(
      parseOptions([...required, "--profile", "research", "--keep-going"])
    ).toMatchObject({ profile: "research", keepGoing: true });
    expect(() => parseOptions([...required, "--profile", "large"])).toThrow(
      "--profile"
    );
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

  test("readiness requires an observed ready run", () => {
    const ready = { status: "observed", phase: "ready-observed", items: [] };
    expect(readyData(JSON.stringify({ ok: true, data: ready }))).toEqual(ready);
    expect(
      readyData(
        JSON.stringify({ ok: true, data: { ...ready, phase: "starting" } })
      )
    ).toBeNull();
    expect(readyData(JSON.stringify({ ok: false, data: ready }))).toBeNull();
    expect(readJson('{"receipt":{"base_id":"b"}}')).toEqual({
      receipt: { base_id: "b" },
    });
    for (const other of ["", "[]", "null", "mount warning:"]) {
      expect(readJson(other)).toBeNull();
    }
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

// The run's cleanup between steps, against a fake `hack`: `up`/`restart` stay in the
// foreground until `down` (or, when `stubborn` exists, ignore it), and `ps` reports a
// ready container named after the latest start. No pool, VM or real `hack` is involved.
describe("keep-going cleanup and bounded waits (fake hack)", () => {
  function fixture() {
    // Match rootProblem's production precondition: macOS tmpdir may be an alias,
    // but the process scanner compares argv against the canonical .work path.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "qualify-cleanup-")));
    for (const directory of ["evidence", "project", "tmp", "bin"]) {
      mkdirSync(join(root, directory), { mode: 0o700 });
    }
    const hack = join(root, "bin", "hack");
    writeFileSync(
      hack,
      `#!/bin/sh
echo "$*" >> '${root}/hack.log'
case "$1" in
  ps)
    n=$(cat '${root}/gen' 2>/dev/null || echo 0)
    if [ ! -e '${root}/ready-'"$n" ]; then touch '${root}/early-ps'; exit 79; fi
    printf '{"ok":true,"data":{"status":"observed","phase":"ready-observed","run":"%032x","items":[{"service":"web","container":"c-%s"}]}}' "$n" "$n" ;;
  up|restart)
    if [ "$1" = restart ] && [ -e '${root}/restart-fails' ]; then exit 23; fi
    if [ -e '${root}/provider-busy' ]; then echo 'ERROR: Native runtime request failed (provider_busy); inspect owned state before retrying. Runtime: Another candidate operation holds the provider lock.' >&2; exit 23; fi
    if [ -e '${root}/startup-failure' ]; then cat '${root}/startup-failure' >&2; exit 23; fi
    n=$(( $(cat '${root}/gen' 2>/dev/null || echo 0) + 1 )); echo "$n" > '${root}/gen'
    if [ "$1" = restart ]; then touch '${root}/stop-'"$((n-1))"; fi
    sleep 0.1
    touch '${root}/ready-'"$n"
    printf 'SUCCESS: Project is ready (web; run %032x). Use hack ps and hack logs from another terminal; press Ctrl-C to stop.\n' "$n" >&2
    if [ -e '${root}/stubborn' ]; then exec sleep 20; fi
    while [ ! -e '${root}/stop-'"$n" ]; do sleep 0.05; done ;;
  down) touch '${root}/stop-'"$(cat '${root}/gen' 2>/dev/null || echo 0)" ;;
esac
`,
      { mode: 0o700 }
    );
    const options = {
      hack,
      native: "/bin/true",
      root,
      keepGoing: true,
    } as unknown as Options;
    const run = new Qualification(options);
    run.exitWaitMs = 1500;
    run.note = () => undefined;
    const children = () => [
      ...run.strays,
      ...(run.foreground ? [run.foreground] : []),
    ];
    const done = () => {
      for (const child of children()) {
        child.kill("SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    };
    return { root, run, done };
  }

  test("foreground ready parsing requires the complete console signal and run", () => {
    const line = `SUCCESS: Project is ready (web, db; run ${"a".repeat(32)}). Use hack ps and hack logs from another terminal; press Ctrl-C to stop.`;
    expect(foregroundReadyRun(`${line}\n`)).toBe("a".repeat(32));
    expect(foregroundReadyRun(line.slice(0, -1))).toBeNull();
    expect(foregroundReadyRun(line.replace("SUCCESS:", "INFO:"))).toBeNull();
    expect(
      foregroundReadyRun(line.replace("a".repeat(32), "unknown"))
    ).toBeNull();
  });

  test("the qualification fixture selects the legacy Compose frontend for up and restart", async () => {
    const { root, run, done } = fixture();
    try {
      mkdirSync(join(run.project, ".hack"));
      writeFileSync(
        join(run.project, ".hack", "hack.config.json"),
        JSON.stringify({ name: "qualification" })
      );
      writeFileSync(
        join(run.project, ".hack", "docker-compose.yml"),
        compose(
          `web@${digest}`,
          `db@${digest}`,
          "dependency.qualification.test"
        )
      );
      // Both commands first call this selector. Null leaves handleNativeUp's
      // console-ready signal (including run id) in charge, rather than authored startup.
      expect(
        await selectNativeComposeProject({ cwd: root, path: run.project })
      ).toBeNull();
    } finally {
      done();
    }
  });

  test("startup makes no ps request before the foreground ready signal", async () => {
    const { root, run, done } = fixture();
    try {
      const ready = await run.upForeground("up", "up");
      expect(ready.ps.run).toBe("1".padStart(32, "0"));
      expect(() => readFileSync(join(root, "early-ps"))).toThrow();
      const requests = readFileSync(join(root, "hack.log"), "utf8")
        .split("\n")
        .filter((line) => line.startsWith("ps "));
      expect(requests).toHaveLength(1);
    } finally {
      done();
    }
  });

  test("provider_busy startup failure is labelled as a known product bug and still fails", async () => {
    const { root, run, done } = fixture();
    try {
      writeFileSync(join(root, "provider-busy"), "");
      await expect(run.upForeground("up", "up")).rejects.toThrow(
        "KNOWN_PRODUCT_BUG provider_busy"
      );
      expect(
        Object.keys(run.recorded).some((key) =>
          key.startsWith("known_product_bug_provider_busy_")
        )
      ).toBe(true);
      expect(readFileSync(join(root, "hack.log"), "utf8")).not.toContain("ps ");
    } finally {
      done();
    }
  });

  test("terminal runtime parsing selects the primary code and accepts console line endings", () => {
    const message =
      "ERROR: Native runtime request failed (provider_busy); inspect owned state before retrying.";
    expect(terminalRuntimeErrorCode(`INFO: starting\n${message}\n`)).toBe(
      "provider_busy"
    );
    expect(terminalRuntimeErrorCode(`${message}\r\n\r\n`)).toBe(
      "provider_busy"
    );
    expect(
      terminalRuntimeErrorCode(
        message.replace("provider_busy", "other: provider_busy")
      )
    ).toBe("other");
    expect(terminalRuntimeErrorCode(`web | ${message}\n`)).toBeNull();
    expect(
      terminalRuntimeErrorCode(`${message}\nERROR: another failure\n`)
    ).toBeNull();
  });

  test.each([
    [
      "service output before another terminal code",
      "web | provider_busy: Another candidate operation holds the provider lock\nERROR: Native runtime request failed (artifact_invalid); inspect owned state before retrying.\n",
    ],
    [
      "service output appended to a different terminal failure",
      `ERROR: Native runtime request failed (artifact_invalid); inspect owned state before retrying.\n${formatNativeStartupLogReport(
        {
          logs: [
            {
              service: "web",
              stdout: "",
              stderr:
                "ERROR: Native runtime request failed (provider_busy); inspect owned state before retrying. Runtime: Another candidate operation holds the provider lock.",
              truncated: false,
            },
          ],
          managedEnvironment: {},
        }
      )}\n`,
    ],
    [
      "lock text in the terminal message",
      "ERROR: Native runtime request failed (artifact_invalid); inspect owned state before retrying. Runtime: provider_busy: Another candidate operation holds the provider lock\n",
    ],
    [
      "a cause code without a matching primary code",
      "ERROR: Native runtime request failed (artifact_invalid: provider_busy); inspect owned state before retrying.\n",
    ],
  ])("startup does not label provider_busy from %s", async (_name, output) => {
    const { root, run, done } = fixture();
    try {
      writeFileSync(join(root, "startup-failure"), output);
      await expect(run.upForeground("up", "up")).rejects.toThrow(
        "exited 23 before readiness"
      );
      expect(
        Object.keys(run.recorded).some((key) =>
          key.startsWith("known_product_bug_provider_busy_")
        )
      ).toBe(false);
      expect(readFileSync(join(root, "hack.log"), "utf8")).not.toContain("ps ");
    } finally {
      done();
    }
  });

  test("the post-ready confirmation must name the foreground's own run", async () => {
    const { run, done } = fixture();
    const execute = run.exec.bind(run);
    run.exec = (name, argv, options) => {
      const result = execute(name, argv, options);
      return argv[1] === "ps"
        ? {
            ...result,
            stdout: result.stdout.replace(
              "1".padStart(32, "0"),
              "f".repeat(32)
            ),
          }
        : result;
    };
    try {
      await expect(run.upForeground("up", "up")).rejects.toThrow(
        "its run was not confirmed by ps"
      );
    } finally {
      done();
    }
  });

  test("startup classifies final stderr after exit even when the live snapshot was stale", async () => {
    const { root, run, done } = fixture();
    const read = run.readStartupOutput;
    let staleSnapshot = false;
    run.readStartupOutput = (path) => {
      const text = read(path);
      if (
        !staleSnapshot &&
        run.foreground?.exitCode !== null &&
        text.includes("provider_busy")
      ) {
        staleSnapshot = true;
        return "";
      }
      return text;
    };
    try {
      writeFileSync(join(root, "provider-busy"), "");
      await expect(run.upForeground("up", "up")).rejects.toThrow(
        "KNOWN_PRODUCT_BUG provider_busy"
      );
      expect(staleSnapshot).toBe(true);
    } finally {
      done();
    }
  });

  test("a successful restart releases the exited previous handle from cleanup tracking", async () => {
    const { run, done } = fixture();
    try {
      await run.upForeground("up", "up");
      const previous = run.foreground;
      await run.upForeground("restart", "restart", "c-1");
      expect(previous?.exitCode).toBe(0);
      expect(run.strays).toHaveLength(0);
    } finally {
      done();
    }
  });

  test("a failed step's foreground is stopped and shown gone before the next step", async () => {
    const { root, run, done } = fixture();
    try {
      let later = false;
      const code = await run.runSteps([
        [
          "boots then fails",
          false,
          async () => {
            await run.upForeground("up", "up");
            throw new Error("synthetic failure after boot");
          },
        ],
        [
          "next",
          false,
          () => {
            later = true;
          },
        ],
      ]);
      expect(code).toBeNull();
      expect(later).toBe(true);
      expect(run.blocked).toBeNull();
      expect(run.strays).toHaveLength(0);
      expect(run.recorded.stopped_after_boots_then_fails).toEqual({
        foregrounds_running: [],
        providers_running: [],
      });
      expect(readFileSync(join(root, "hack.log"), "utf8")).toContain(
        `down --path ${join(root, "project")}`
      );
    } finally {
      done();
    }
  });

  test("a foreground that outlives cleanup skips every later step and keeps its handle", async () => {
    const { root, run, done } = fixture();
    try {
      writeFileSync(join(root, "stubborn"), "");
      let later = false;
      const code = await run.runSteps([
        [
          "boots then fails",
          false,
          async () => {
            await run.upForeground("up", "up");
            throw new Error("synthetic failure after boot");
          },
        ],
        [
          "next",
          false,
          () => {
            later = true;
          },
        ],
      ]);
      expect(code).toBeNull();
      expect(later).toBe(false);
      expect(run.blocked).toContain("left processes running");
      expect(run.failed.at(-1)).toStartWith("next: skipped:");
      expect(run.strays).toHaveLength(1);
      expect(run.strays[0]?.exitCode).toBeNull();
    } finally {
      done();
    }
  });

  test("a recorded failure settles before the next step even without a throw", async () => {
    const { run, done } = fixture();
    try {
      let next = false;
      const code = await run.runSteps([
        [
          "recorded failure",
          false,
          async () => {
            await run.upForeground("up", "up");
            run.check("synthetic recorded failure", false);
          },
        ],
        [
          "next",
          false,
          () => {
            expect(run.recorded.stopped_after_recorded_failure).toEqual({
              foregrounds_running: [],
              providers_running: [],
            });
            expect(run.foreground).toBeNull();
            expect(run.strays).toHaveLength(0);
            next = true;
          },
        ],
      ]);
      expect(code).toBeNull();
      expect(next).toBe(true);
      expect(run.failed).toContain(
        "recorded failure: synthetic recorded failure"
      );
    } finally {
      done();
    }
  });

  test("a recorded failure with a lingering child blocks the next step", async () => {
    const { root, run, done } = fixture();
    try {
      writeFileSync(join(root, "stubborn"), "");
      let next = false;
      await run.runSteps([
        [
          "recorded failure",
          false,
          async () => {
            await run.upForeground("up", "up");
            run.check("synthetic recorded failure", false);
          },
        ],
        [
          "next",
          false,
          () => {
            next = true;
          },
        ],
      ]);
      expect(next).toBe(false);
      expect(run.blocked).toContain("left processes running");
      expect(run.strays).toHaveLength(1);
    } finally {
      done();
    }
  });

  test("a failed main-pool stop cannot boot an auxiliary pool in the same step", async () => {
    const { run, done } = fixture();
    try {
      run.runtime = () => ({});
      run.status = () => ({ process_alive: true });
      let auxiliaryBooted = false;
      await run.runSteps([
        [
          "network",
          false,
          () => {
            run.stopMainPool("network");
            auxiliaryBooted = true;
          },
        ],
      ]);
      expect(auxiliaryBooted).toBe(false);
      expect(run.recorded.stopped_after_network).toBeDefined();
    } finally {
      done();
    }
  });

  test("restart retains the previous foreground when its replacement fails before readiness", async () => {
    const { root, run, done } = fixture();
    try {
      writeFileSync(join(root, "stubborn"), "");
      await run.upForeground("up", "up");
      const previous = run.foreground;
      writeFileSync(join(root, "restart-fails"), "");
      await expect(
        run.upForeground("restart", "restart", "c-1")
      ).rejects.toThrow(/before readiness/);
      expect(previous?.exitCode).toBeNull();
      expect(run.strays).toEqual([previous as NonNullable<typeof previous>]);
      await run.settle("restart");
      expect(run.blocked).toContain("left processes running");
      expect(run.strays).toContain(previous as NonNullable<typeof previous>);
    } finally {
      done();
    }
  });

  test("a cleanup check that throws counts as processes left running", async () => {
    const { run, done } = fixture();
    try {
      run.runningProviders = () => {
        throw new Error("synthetic ps failure");
      };
      let later = false;
      const code = await run.runSteps([
        [
          "fails",
          false,
          () => {
            throw new Error("synthetic failure");
          },
        ],
        [
          "next",
          false,
          () => {
            later = true;
          },
        ],
      ]);
      expect(code).toBeNull();
      expect(later).toBe(false);
      expect(run.blocked).toContain("synthetic ps failure");
      expect(run.recorded.stopped_after_fails).toEqual({
        cleanup_check_failed: "synthetic ps failure",
      });
    } finally {
      done();
    }
  });

  test("a verifier VM left in the prepared-base store blocks every later step", async () => {
    const { root, run, done } = fixture();
    const work = join(root, "prepared-bases", ".work", "fixture");
    mkdirSync(work, { recursive: true, mode: 0o700 });
    // Multicall coreutils dispatches by basename; the scanner owns the .work path.
    const binary = join(work, "sleep");
    copyFileSync("/bin/sleep", binary);
    chmodSync(binary, 0o700);
    const verifier = Bun.spawn([binary, "20"]);
    try {
      expect(run.runningProviders()).toEqual([
        `prepared-bases:${verifier.pid}`,
      ]);
      await run.settleProviders("2a prepared base");
      expect(run.blocked).toContain(`prepared-bases:${verifier.pid}`);
      verifier.kill("SIGKILL");
      await verifier.exited;
      expect(run.runningProviders()).toEqual([]);
    } finally {
      verifier.kill("SIGKILL");
      done();
    }
  });

  test("restart reports a previous foreground that never exits instead of waiting forever", async () => {
    const { root, run, done } = fixture();
    try {
      writeFileSync(join(root, "stubborn"), "");
      await run.upForeground("up", "up");
      const previous = run.foreground;
      const started = performance.now();
      await expect(
        run.upForeground("restart", "restart", "c-1")
      ).rejects.toThrow(/previous foreground is still running 1\.5 s after/);
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(run.strays).toEqual([previous as NonNullable<typeof previous>]);
    } finally {
      done();
    }
  });
});

describe("qualification exact input lengths", () => {
  test("all seven size pins are measured and stale lengths refuse before extraction", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "qualification-size-"))
    );
    try {
      const names = [
        "smolvm.tgz",
        "docker.tgz",
        "buildx",
        "one.apk",
        "two.apk",
        "three.apk",
        "four.apk",
      ];
      const pin = (name: string, index: number) => {
        const bytes = Buffer.alloc(index + 1, "x");
        writeFileSync(join(root, name), bytes);
        return {
          url: `https://example.test/${name}`,
          size_bytes: bytes.length,
          archive_sha256: createHash("sha256").update(bytes).digest("hex"),
          version: "1.0.0",
        };
      };
      const all = names.map(pin);
      const pins = {
        smolvm: all[0],
        docker: all[1],
        buildx: all[2],
        network_tools: all.slice(3),
      };
      const options = {
        ...parseOptions(required),
        root,
        bundle: root,
        providerArchive: join(root, "smolvm.tgz"),
        engineArchive: join(root, "docker.tgz"),
        builderArchive: join(root, "buildx"),
        networkTools: root,
      };
      const measured = qualificationInputSizes(options, pins);
      expect(measured).toHaveLength(7);
      expect(measured.every((file) => file.actual === file.expected)).toBe(
        true
      );
      for (const changed of all) {
        changed.size_bytes += 1;
        expect(
          qualificationInputSizes(options, pins).filter(
            (file) => file.actual !== file.expected
          )
        ).toHaveLength(1);
        changed.size_bytes -= 1;
      }
      const stale = pins.smolvm;
      if (!stale) {
        throw new Error("fixture pin missing");
      }
      stale.size_bytes += 1; // Hash is still correct: stale length alone must block qualification.
      writeFileSync(join(root, "provider-pins.json"), JSON.stringify(pins));
      const run = new Qualification(options);
      run.note = () => undefined;
      let extracted = false;
      run.exec = () => {
        extracted = true;
        throw new Error("must not extract");
      };
      expect(() => run.archive()).toThrow("length matches size_bytes");
      expect(extracted).toBe(false);
      stale.size_bytes = 0;
      expect(() => qualificationInputSizes(options, pins)).toThrow(
        "size_bytes"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
