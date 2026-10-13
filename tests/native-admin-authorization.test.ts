import { expect, test } from "bun:test";
import {
  type AdministratorAuthorization,
  type AdministratorAuthorizationFailure,
  ownsTerminalForeground,
  requestAdministratorAuthorization,
} from "../src/lib/admin-authorization.ts";
import { createHackLocalRouteAuthorizer } from "../src/lib/native-hack-local-route-host.ts";
import type { RunOptions } from "../src/lib/shell.ts";
import {
  pausableSpinner,
  withTerminalHandoff,
} from "../src/lib/terminal-handoff.ts";
import { hasControllingTerminal } from "../src/lib/tty-process-group.ts";

/** Records sudo invocations; never runs a real command. */
function fakeRunner(exitCode: number) {
  const calls: { command: string[]; options: RunOptions | undefined }[] = [];
  return {
    calls,
    runCommand: async (command: readonly string[], options?: RunOptions) => {
      calls.push({ command: [...command], options });
      return exitCode;
    },
  };
}

test("the administrator prompt runs sudo -v in the foreground terminal, never sudo -n", async () => {
  const runner = fakeRunner(0);
  expect(
    await requestAdministratorAuthorization({
      dependencies: {
        runCommand: runner.runCommand,
        ownsTerminalForeground: () => true,
      },
    })
  ).toEqual({ status: "authorized" });
  expect(runner.calls).toEqual([
    {
      command: ["sudo", "-v"],
      options: { stdin: "inherit", timeoutMs: 120_000, forwardSignals: true },
    },
  ]);
});

test("sudo failures are classified, never treated as a decline", async () => {
  const cases: readonly [number, AdministratorAuthorizationFailure][] = [
    [124, "timed-out"],
    [130, "interrupted"],
    [143, "interrupted"],
    [1, "rejected"],
  ];
  for (const [exitCode, failure] of cases) {
    const runner = fakeRunner(exitCode);
    expect(
      await requestAdministratorAuthorization({
        dependencies: {
          runCommand: runner.runCommand,
          ownsTerminalForeground: () => true,
        },
      })
    ).toEqual({ status: "failed", failure, exitCode });
  }
});

test("a background run refuses before sudo can stop or read nothing", async () => {
  const runner = fakeRunner(0);
  expect(
    await requestAdministratorAuthorization({
      dependencies: {
        runCommand: runner.runCommand,
        ownsTerminalForeground: () => false,
      },
    })
  ).toEqual({ status: "failed", failure: "not-foreground", exitCode: null });
  expect(runner.calls).toEqual([]);
});

test.skipIf(process.stdin.isTTY === true || hasControllingTerminal())(
  "without a terminal the process never owns a terminal foreground",
  () => {
    expect(ownsTerminalForeground()).toBe(false);
  }
);

test("route authorization confirms first and only then prompts for the administrator", async () => {
  const order: string[] = [];
  const outcome = (result: AdministratorAuthorization) =>
    createHackLocalRouteAuthorizer({
      confirm: async () => {
        order.push("confirm");
        return true;
      },
      requestAdministrator: async () => {
        order.push("sudo -v");
        return result;
      },
    });

  expect(await outcome({ status: "authorized" })("Repair?")).toEqual({
    outcome: "approved",
  });
  expect(order).toEqual(["confirm", "sudo -v"]);

  expect(
    await outcome({ status: "failed", failure: "timed-out", exitCode: 124 })(
      "Repair?"
    )
  ).toEqual({
    outcome: "authorization-failed",
    detail: "the macOS administrator prompt timed out after 120 seconds",
  });
  expect(
    await outcome({ status: "failed", failure: "rejected", exitCode: 1 })(
      "Repair?"
    )
  ).toEqual({
    outcome: "authorization-failed",
    detail: "sudo -v did not accept the administrator password (exit 1)",
  });
});

test("a no at the confirmation is declined and never reaches sudo", async () => {
  const order: string[] = [];
  const authorize = createHackLocalRouteAuthorizer({
    confirm: async () => {
      order.push("confirm");
      return false;
    },
    requestAdministrator: async () => {
      order.push("sudo -v");
      return { status: "authorized" };
    },
  });
  expect(await authorize("Repair?")).toEqual({ outcome: "declined" });
  expect(order).toEqual(["confirm"]);
});

function recordingSpinner() {
  const events: string[] = [];
  return {
    events,
    indicator: {
      start: (message?: string) => events.push(`start:${message ?? ""}`),
      stop: (message?: string) => events.push(`stop:${message ?? ""}`),
      clear: () => events.push("clear"),
    },
  };
}

test("the spinner is erased before a prompt and redrawn with its message after", async () => {
  const spinner = recordingSpinner();
  const progress = pausableSpinner(spinner.indicator);
  progress.start("Checking the active native HTTPS root...");
  const result = await withTerminalHandoff(progress, async (claim) => {
    spinner.events.push("inspect");
    claim();
    spinner.events.push("prompt");
    claim();
    spinner.events.push("sudo -n");
    return "done";
  });
  expect(result).toBe("done");
  progress.stop("Native doctor checks complete");
  expect(spinner.events).toEqual([
    "start:Checking the active native HTTPS root...",
    "inspect",
    "clear",
    "prompt",
    "sudo -n",
    "start:Checking the active native HTTPS root...",
    "stop:Native doctor checks complete",
  ]);
});

test("a step that never prompts keeps the spinner drawing", async () => {
  const spinner = recordingSpinner();
  const progress = pausableSpinner(spinner.indicator);
  progress.start("Checking");
  await withTerminalHandoff(progress, async () => {
    spinner.events.push("inspect");
  });
  expect(spinner.events).toEqual(["start:Checking", "inspect"]);
});

test("a failing step still returns the terminal to the spinner", async () => {
  const spinner = recordingSpinner();
  const progress = pausableSpinner(spinner.indicator);
  progress.start("Checking");
  await expect(
    withTerminalHandoff(progress, async (claim) => {
      claim();
      throw new Error("prompt failed");
    })
  ).rejects.toThrow("prompt failed");
  expect(spinner.events).toEqual(["start:Checking", "clear", "start:Checking"]);
});

test("pausing an idle spinner draws nothing", () => {
  const spinner = recordingSpinner();
  const progress = pausableSpinner(spinner.indicator);
  progress.pause();
  progress.resume();
  expect(spinner.events).toEqual([]);
});
