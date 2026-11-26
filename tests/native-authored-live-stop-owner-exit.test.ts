import { expect, test } from "bun:test";
import { waitForNativeAuthoredStopOwnerExit } from "../src/backends/native-authored-live-stop.ts";

const budget = () => 60_000;

// HACK-2715 review round 2 (seen on a real VM): after a dispatched stop whose
// cleanup could not remove the run, the requester waits, bounded, for the
// recorded owner process to exit, so `hack down` can settle the run by the
// dead-owner recovery in the same command instead of reporting "unconfirmed".
test("HACK-2715 review round 2: a stop requester sees its owner exit, and only then", async () => {
  const owner = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
  setTimeout(() => owner.kill("SIGTERM"), 200);
  expect(
    await waitForNativeAuthoredStopOwnerExit(owner.pid, budget, undefined)
  ).toBe(true);
  await owner.exited;

  // An owner that stays up is reported as not exited once the bound passes.
  const stays = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
  try {
    expect(
      await waitForNativeAuthoredStopOwnerExit(
        stays.pid,
        budget,
        undefined,
        300
      )
    ).toBe(false);
    // A canceled stop does not wait.
    const controller = new AbortController();
    controller.abort();
    expect(
      await waitForNativeAuthoredStopOwnerExit(
        stays.pid,
        budget,
        controller.signal
      )
    ).toBe(false);
    // An expired stop budget ends the wait too.
    expect(
      await waitForNativeAuthoredStopOwnerExit(
        stays.pid,
        () => {
          throw new Error("expired");
        },
        undefined
      )
    ).toBe(false);
  } finally {
    stays.kill("SIGKILL");
    await stays.exited;
  }
  // Never this process, and never an invalid pid.
  for (const pid of [process.pid, 0, 1, -5, 1.5]) {
    expect(
      await waitForNativeAuthoredStopOwnerExit(pid, budget, undefined, 100)
    ).toBe(false);
  }
});
