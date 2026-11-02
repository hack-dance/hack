import { expect, test } from "bun:test";
import {
  NativeAuthoredProjectRestartError,
  type NativeAuthoredProjectRestartOptions,
  restartNativeAuthoredProject,
} from "../src/backends/native-authored-project-restart.ts";
import type { stopNativeAuthoredProject } from "../src/backends/native-authored-project-run.ts";
import {
  NativeAuthoredProjectStartError,
  type serveNativeAuthoredProject,
} from "../src/backends/native-authored-project-start.ts";

type Stop = Parameters<typeof stopNativeAuthoredProject>[0];
type Startup = Parameters<typeof serveNativeAuthoredProject>[0];
const PRIVATE = "synthetic-private-restart-detail";
const macTest = process.platform === "darwin" ? test : test.skip;

function selection(
  extra: Partial<NativeAuthoredProjectRestartOptions> = {}
): NativeAuthoredProjectRestartOptions {
  return {
    runtime: { binary: "/absolute/native", home: "/absolute/home" },
    scope: {
      projectRoot: "/absolute/project",
      projectDir: "/absolute/project/.hack",
      nativeHome: "/absolute/home",
      branch: "feature/$exact",
    },
    run: "a".repeat(32),
    profiles: ["b", "a"],
    overlay: "dev",
    startupTimeoutMs: 1500,
    ...extra,
  };
}

function recorder() {
  const events: string[] = [];
  const stops: Stop[] = [];
  const startups: Startup[] = [];
  return {
    events,
    stops,
    startups,
    stop: (input: Stop) => {
      events.push("stop");
      stops.push(input);
      return Promise.resolve();
    },
    serve: (input: Startup) => {
      events.push("serve");
      startups.push(input);
      return Promise.resolve(19);
    },
  };
}

macTest(
  "proven stop precedes a fresh foreground start with the captured selection",
  async () => {
    const seams = recorder();
    const profiles = ["b", "a"];
    const controller = new AbortController();
    const force = new AbortController();
    const input = selection({
      profiles,
      signal: controller.signal,
      forceSignal: force.signal,
      onStopped: () => {
        seams.events.push("stopped");
        return undefined;
      },
      dependencies: seams,
    });
    const pending = restartNativeAuthoredProject(input);
    profiles.push("replacement");
    expect(await pending).toBe(19);
    expect(seams.events).toEqual(["stop", "stopped", "serve"]);
    const [stop] = seams.stops;
    const [startup] = seams.startups;
    if (!(stop && startup)) {
      throw new Error("fixture requires both delegated owners");
    }
    expect(stop.scope).toEqual(input.scope);
    expect(stop.timeoutMs).toBe(1500);
    expect(stop.signal).toBe(controller.signal);
    expect(startup.runtime).toEqual(input.runtime);
    expect(startup.scope).toEqual(input.scope);
    expect(startup.run).toBe("a".repeat(32));
    expect(startup.profiles).toEqual(["b", "a"]);
    expect(startup.overlay).toBe("dev");
    expect(startup.startupTimeoutMs).toBe(1500);
    expect(startup.signal).toBe(controller.signal);
    expect(startup.forceSignal).toBe(force.signal);
  }
);

macTest("the fresh start waits for the stop owner to settle", async () => {
  const seams = recorder();
  const settled = Promise.withResolvers<void>();
  const pending = restartNativeAuthoredProject(
    selection({
      dependencies: {
        stop: () => {
          seams.events.push("stop");
          return settled.promise;
        },
        serve: seams.serve,
      },
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(seams.events).toEqual(["stop"]);
  settled.resolve();
  expect(await pending).toBe(19);
  expect(seams.events).toEqual(["stop", "serve"]);
});

macTest(
  "an unproven stop retains the generation and never starts",
  async () => {
    const seams = recorder();
    let stopped = 0;
    const error = await restartNativeAuthoredProject(
      selection({
        onStopped: () => {
          stopped++;
          return undefined;
        },
        dependencies: {
          stop: () => Promise.reject(new Error(PRIVATE)),
          serve: seams.serve,
        },
      })
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAuthoredProjectRestartError);
    expect(error).toHaveProperty("phase", "stop");
    expect(error).toHaveProperty("canceled", false);
    expect(error).toHaveProperty("startup", undefined);
    expect(String(error)).not.toContain(PRIVATE);
    expect(String(error)).toContain("nothing was restarted");
    expect(stopped).toBe(0);
    expect(seams.events).toEqual([]);
  }
);

macTest.each(["signal", "forceSignal"] as const)(
  "%s cancellation between the proven stop and the fresh start starts nothing",
  async (kind) => {
    const seams = recorder();
    const controller = new AbortController();
    let stopped = 0;
    const error = await restartNativeAuthoredProject(
      selection({
        [kind]: controller.signal,
        onStopped: () => {
          stopped++;
          return undefined;
        },
        dependencies: {
          stop: () => {
            seams.events.push("stop");
            controller.abort();
            return Promise.resolve();
          },
          serve: seams.serve,
        },
      })
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAuthoredProjectRestartError);
    expect(error).toHaveProperty("phase", "start");
    expect(error).toHaveProperty("canceled", true);
    expect(error).toHaveProperty("startup", undefined);
    expect(String(error)).toContain("canceled after the proven stop");
    expect(stopped).toBe(0);
    expect(seams.events).toEqual(["stop"]);
  }
);

macTest(
  "a startup refusal after the proven stop keeps only the closed startup diagnostic",
  async () => {
    const seams = recorder();
    const startup = new NativeAuthoredProjectStartError({
      outcome: "not-started",
      canceled: false,
      stage: "inputs",
      compilerCode: "E_COMPILER_RESPONSE",
    });
    for (const thrown of [startup, new Error(PRIVATE)]) {
      const error = await restartNativeAuthoredProject(
        selection({
          dependencies: {
            stop: seams.stop,
            serve: () => Promise.reject(thrown),
          },
        })
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NativeAuthoredProjectRestartError);
      expect(error).toHaveProperty("phase", "start");
      expect(error).toHaveProperty("canceled", false);
      expect(String(error)).not.toContain(PRIVATE);
      if (thrown === startup) {
        expect(error).toHaveProperty("startup", startup);
        expect(String(error)).toContain("stage inputs (E_COMPILER_RESPONSE)");
      } else {
        expect(error).toHaveProperty("startup", undefined);
        expect(String(error)).toContain("startup is unconfirmed");
      }
    }
    expect(seams.events).toEqual(["stop", "stop"]);
  }
);

macTest(
  "a canceled startup after the proven stop reports the owner's cancellation",
  async () => {
    const seams = recorder();
    const error = await restartNativeAuthoredProject(
      selection({
        dependencies: {
          stop: seams.stop,
          serve: () =>
            Promise.reject(
              new NativeAuthoredProjectStartError({
                outcome: "removed",
                canceled: true,
              })
            ),
        },
      })
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAuthoredProjectRestartError);
    expect(error).toHaveProperty("phase", "start");
    expect(error).toHaveProperty("canceled", true);
    expect(error).toHaveProperty("startup.outcome", "removed");
  }
);

macTest("an invalid selection refuses before the stop owner", async () => {
  const aborted = new AbortController();
  aborted.abort();
  for (const extra of [
    { run: "not-a-run" },
    { run: "A".repeat(32) },
    { startupTimeoutMs: 0 },
    { startupTimeoutMs: 300_001 },
    { startupTimeoutMs: Number.NaN },
    { startupTimeoutMs: 1.5 },
    { runtime: { binary: "relative", home: "/absolute/home" } },
    { runtime: { binary: "/absolute/native", home: "/absolute/other" } },
    { signal: aborted.signal },
    { forceSignal: aborted.signal },
  ] satisfies readonly Partial<NativeAuthoredProjectRestartOptions>[]) {
    const seams = recorder();
    const error = await restartNativeAuthoredProject(
      selection({ ...extra, dependencies: seams })
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAuthoredProjectRestartError);
    expect(error).toHaveProperty("phase", "stop");
    expect(error).toHaveProperty(
      "canceled",
      "signal" in extra && extra.signal === aborted.signal
    );
    expect(seams.events).toEqual([]);
  }
});

test("restart diagnostics stay fixed across phases", () => {
  const startup = new NativeAuthoredProjectStartError({
    outcome: "retained",
    canceled: false,
  });
  expect(
    new NativeAuthoredProjectRestartError({ phase: "stop", canceled: true })
  ).toMatchObject({ phase: "stop", canceled: true, startup: undefined });
  // A startup diagnostic never attaches to the stop phase.
  expect(
    new NativeAuthoredProjectRestartError({
      phase: "stop",
      canceled: false,
      startup,
    })
  ).toHaveProperty("startup", undefined);
  expect(
    String(
      new NativeAuthoredProjectRestartError({
        phase: "start",
        canceled: false,
        startup,
      })
    )
  ).toContain("startup evidence is retained");
});

if (process.platform !== "darwin") {
  test("unsupported host refuses native restart before the stop owner", async () => {
    const seams = recorder();
    const error = await restartNativeAuthoredProject(
      selection({ dependencies: seams })
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeAuthoredProjectRestartError);
    expect(error).toHaveProperty("phase", "stop");
    expect(seams.events).toEqual([]);
  });
}
