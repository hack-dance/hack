import { expect, test } from "bun:test";
import { fstatSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  prepareRuntimeTiming,
  timedNativeSpawn,
  withCommandTimings,
} from "../src/lib/command-timings.ts";
import { readTimingLine } from "../src/lib/timing-record.ts";

const options = {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  env: {
    HACK_DAEMON_AUTOSTART_DISABLE: "1",
    FIXTURE_INPUT: "private-env-value",
  },
} as const;
async function fixture(action: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-timings-")));
  try {
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const childSource = `import {writeSync} from "node:fs";
const p=process.argv[2].replace("--internal-timings=","").split(":");
writeSync(3,JSON.stringify({schema:"hack.timings/1",trace:p[1],span:"00f067aa0ba902b7",parent:p[2],proc:"runtime",clock:"host",origin_unix_us:1,origin_mono_us:1,step:"container.start",start_us:0,dur_us:1,outcome:"ok",attrs:{service_index:2}})+"\\n");`;
test("child descriptor joins identities; stdout/stderr and private values stay out", () =>
  fixture(async (root) => {
    const script = join(root, "child.ts"),
      output = join(root, "alias", "timings.jsonl");
    symlinkSync(root, join(root, "alias"));
    await writeFile(script, `#!${process.execPath}\n${childSource}`, {
      mode: 0o700,
    });
    await withCommandTimings(output, async () => {
      const child = timedNativeSpawn(
        [script, "private-service", "private-env-value"],
        options
      );
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
    });
    const text = await readFile(output, "utf8"),
      records = text.trim().split("\n").map(readTimingLine);
    expect(records.every(Boolean)).toBe(true);
    const service = records.find((r) => r?.step === "container.start"),
      request = records.find((r) => r?.step === "runtime.request");
    expect(service?.parent).toBe(request?.span);
    expect(service?.trace).toBe(request?.trace);
    for (const value of [root, "private-service", "private-env-value"]) {
      expect(text.includes(value)).toBe(false);
    }
  }));
test("failed spawn closes transferred descriptor and the command still finalizes", () =>
  fixture(async (root) => {
    await withCommandTimings(join(root, "failure"), async () => {
      const timing = prepareRuntimeTiming();
      expect(timing).toBeDefined();
      timing?.failed();
      expect(() => fstatSync(timing?.sender ?? -1)).toThrow();
      expect(() =>
        timedNativeSpawn(["/not-a-timing-fixture-executable"], options)
      ).toThrow();
    });
    const records = (await readFile(join(root, "failure"), "utf8"))
      .trim()
      .split("\n")
      .map(readTimingLine);
    expect(records.filter((r) => r?.outcome === "error").length).toBe(2);
  }));
test("disabled step has no context or descriptor", async () => {
  expect(prepareRuntimeTiming()).toBeUndefined();
  const child = timedNativeSpawn(["/bin/true"], options);
  expect(await child.exited).toBe(0);
});
test("compiled CLI can use the native clock and pass an extra descriptor", () =>
  fixture(async (root) => {
    const source = join(root, "compiled.ts"),
      binary = join(root, "compiled"),
      output = join(root, "records");
    const helper = join(root, "helper.sh");
    await writeFile(helper, "#!/bin/sh\nprintf '{}\\n' >&3\n", { mode: 0o700 });
    await writeFile(
      source,
      `import {withCommandTimings,timedNativeSpawn} from ${JSON.stringify(resolve(import.meta.dir, "../src/lib/command-timings.ts"))}; await withCommandTimings(process.argv[2],async()=>{timedNativeSpawn([${JSON.stringify(helper)}],${JSON.stringify(options)});});`
    );
    const build = Bun.spawn(
      [process.execPath, "build", source, "--compile", "--outfile", binary],
      options
    );
    expect(await build.exited).toBe(0);
    const child = Bun.spawn([binary, output], options);
    expect(await child.exited).toBe(0);
    const records = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map(readTimingLine);
    expect(records.every((r) => r?.clock === "host")).toBe(true);
    expect(
      records.some((r) => r?.step === "runtime.request" && r.outcome === "ok")
    ).toBe(true);
  }));
test("signals settle drains before the timing file closes", () =>
  fixture(async (root) => {
    const helper = join(root, "wait.sh"),
      output = join(root, "signal");
    await writeFile(helper, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
    await withCommandTimings(output, async () => {
      const child = timedNativeSpawn([helper], options);
      child.kill("SIGKILL");
      await child.exited;
    });
    const records = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map(readTimingLine);
    expect(
      records.some(
        (r) => r?.step === "runtime.request" && r.outcome === "error"
      )
    ).toBe(true);
  }));

// A failed first host sample fixes this collector in fallback mode permanently.
test("clock mode is latched across failing and recovering samples", () =>
  fixture(async (root) => {
    const native = await import("../src/lib/native-timing-transport.ts");
    for (const samples of [
      [undefined, 5_000_000],
      [undefined, undefined],
      [5_000_000, undefined],
    ]) {
      let calls = 0;
      const transport = {
        ...native,
        hostMonotonicUs: () => samples[Math.min(calls++, 1)],
      };
      const output = join(
        root,
        `clock-${samples[0] ?? "fallback"}-${samples[1] ?? "fail"}`
      );
      await withCommandTimings(
        output,
        async () => {
          const child = prepareRuntimeTiming();
          expect(child).toBeDefined();
          expect(child?.args[0]?.split(":")[3]).toBe(
            String(Number.MAX_SAFE_INTEGER + 1)
          );
          child?.failed();
        },
        transport
      );
      const records = (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .map(readTimingLine);
      expect(
        records.every(
          (r) => r && r.start_us < 1_000_000 && r.dur_us < 1_000_000
        )
      ).toBe(true);
      expect(
        records.every(
          (r) => r?.clock === (samples[0] === undefined ? "guest" : "host")
        )
      ).toBe(true);
      if (samples[0] === undefined) {
        expect(calls).toBe(1);
      }
    }
  }));
test("timing failure cannot replace product success or its original error", () =>
  fixture(async (root) => {
    const { CommandTimings } = await import("../src/lib/command-timings.ts");
    const native = await import("../src/lib/native-timing-transport.ts");
    const { openSync, closeSync } = await import("node:fs");
    for (const fails of [false, true]) {
      const fd = openSync(join(root, `closed-${fails}`), "wx", 0o600),
        trace = new CommandTimings(fd, native);
      closeSync(fd);
      const product = new Error("product failure");
      const run = async () => {
        try {
          return await trace.measure("command.total", async () => {
            if (fails) {
              throw product;
            }
            return 17;
          });
        } finally {
          await trace.finish();
        }
      };
      if (fails) {
        await expect(run()).rejects.toBe(product);
      } else {
        expect(await run()).toBe(17);
      }
      expect(() => fstatSync(fd)).toThrow();
    }
  }));
test("rejected child exits drain residual records and close unfinished preparations", () =>
  fixture(async (root) => {
    const native = await import("../src/lib/native-timing-transport.ts");
    let channels = 0,
      closed = 0,
      drained = 0;
    const transport = {
      ...native,
      timingChannel: () => ({
        sender: 100,
        close: () => {
          closed++;
        },
        closeSender: () => {},
        drain: () => {
          drained++;
        },
      }),
    };
    await withCommandTimings(
      join(root, "rejected"),
      async () => {
        const child = prepareRuntimeTiming();
        child?.started(Promise.reject(new Error("rejected")));
        prepareRuntimeTiming();
        channels += 2;
        for (const fd of [2, Number.NaN, 3.5, Number.POSITIVE_INFINITY]) {
          expect(() => prepareRuntimeTiming(fd)).toThrow();
        }
      },
      transport
    );
    expect(closed).toBe(channels);
    expect(drained).toBeGreaterThanOrEqual(2);
    const records = (await readFile(join(root, "rejected"), "utf8"))
      .trim()
      .split("\n")
      .map(readTimingLine);
    expect(records.some((r) => r?.outcome === "incomplete")).toBe(true);
  }));
test("live drain, closed sender, fd4 protocol and ALS parentage", () =>
  fixture(async (root) => {
    const native = await import("../src/lib/native-timing-transport.ts");
    const protocol = native.timingChannel(),
      output = join(root, "live"),
      script = join(root, "live.ts");
    await writeFile(
      script,
      `#!${process.execPath}\n${childSource.replace("writeSync(3,", "writeSync(Number(p[0]),")}\nwriteSync(3,"protocol");await Bun.sleep(10000);`,
      { mode: 0o700 }
    );
    let sender = -1;
    const transport = {
      ...native,
      timingChannel: () => {
        const c = native.timingChannel();
        sender = c.sender;
        return c;
      },
    };
    try {
      await withCommandTimings(
        output,
        async () => {
          const child = timedNativeSpawn(
            [script],
            { ...options, stdio: ["ignore", "pipe", "pipe", protocol.sender] },
            4
          );
          try {
            expect(() => fstatSync(sender)).toThrow();
            const deadline = Date.now() + 2000;
            while (
              !(await readFile(output, "utf8")).includes("container.start") &&
              Date.now() < deadline
            ) {
              await Bun.sleep(5);
            }
            expect(child.exitCode).toBeNull();
            expect(
              (await readFile(output, "utf8")).includes("container.start")
            ).toBe(true);
            const lines: string[] = [];
            protocol.drain((line) => lines.push(line));
            expect(lines).toEqual(["protocol"]);
          } finally {
            child.kill("SIGKILL");
            await child.exited;
          }
        },
        transport
      );
    } finally {
      protocol.close();
    }
    const records = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map(readTimingLine);
    const request = records.find((r) => r?.step === "runtime.request"),
      command = records.find((r) => r?.step === "command.total");
    expect(request?.parent).toBe(command?.span);
    expect(records.some((r) => r?.step === "container.start")).toBe(true);
  }));
test("relay caps each child and ignores foreign traces", () =>
  fixture(async (root) => {
    const native = await import("../src/lib/native-timing-transport.ts");
    const queue: string[] = [];
    const transport = {
      ...native,
      timingChannel: () => ({
        sender: 100,
        close: () => {},
        closeSender: () => {},
        drain: (consume: (line: string) => void) => {
          for (const line of queue.splice(0)) {
            consume(line);
          }
        },
      }),
    };
    const output = join(root, "bounded");
    await withCommandTimings(
      output,
      async () => {
        const child = prepareRuntimeTiming(),
          parts = child?.args[0]?.split(":");
        const record = {
          schema: "hack.timings/1",
          trace: parts?.[1],
          span: "00f067aa0ba902b7",
          parent: parts?.[2],
          proc: "runtime",
          clock: "host",
          origin_unix_us: 1,
          origin_mono_us: 1,
          step: "container.start",
          start_us: 0,
          dur_us: 1,
          outcome: "ok",
          attrs: {},
        };
        queue.push(
          JSON.stringify({
            ...record,
            trace: "53995c3f42cd8ad84bf92f3577b34da6",
          })
        );
        queue.push(
          ...Array.from({ length: 2100 }, (_, index) =>
            JSON.stringify({
              ...record,
              span: (index + 1).toString(16).padStart(16, "0"),
            })
          )
        );
        child?.started(Promise.resolve(0));
      },
      transport
    );
    const records = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map(readTimingLine);
    expect(records.filter((r) => r?.step === "container.start")).toHaveLength(
      2048
    );
    expect(
      records.find((r) => r?.step === "timings.truncated")?.attrs.dropped
    ).toBe(52);
    expect(new Set(records.map((r) => r?.trace)).size).toBe(1);
  }));
