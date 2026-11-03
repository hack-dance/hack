/** Private subprocess: records caller admission separately from lower-level guards. */
import { mock } from "bun:test";
import { join } from "node:path";
import * as launchd from "../../src/daemon/launchd.ts";
import { CURRENT_CA_PEM } from "../helpers/ca-certificates.ts";

if (Bun.which("launchctl") !== process.env.HACK_TEST_STUB_LAUNCHCTL) {
  throw new Error("Recording launchctl stub must be first on PATH");
}

const mode = process.argv[2];
let statusCalls = 0;
if (mode === "offer" || mode === "client") {
  mock.module("../../src/daemon/launchd.ts", () => ({
    ...launchd,
    getLaunchdServiceStatus: () => {
      statusCalls += 1;
      return Promise.resolve({
        installed: true,
        loaded: true,
        running: false,
        pid: null,
        exitStatus: null,
      });
    },
    kickstartLaunchdService: () => Promise.resolve({ ok: false }),
  }));
}

if (mode === "client") {
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  }
  const { requestDaemonJson } = await import("../../src/daemon/client.ts");
  await requestDaemonJson({ path: "/v1/status" });
} else {
  const { configureMacHostTlsTrust, maybeOfferMacHackdLaunchdInstall } =
    await import("../../src/commands/global.ts");
  if (mode === "offer") {
    await maybeOfferMacHackdLaunchdInstall();
  } else if (mode === "tls") {
    const certPath = join(process.env.HACK_HOME ?? "", "test-ca.pem");
    await Bun.write(certPath, CURRENT_CA_PEM);
    const ready = await configureMacHostTlsTrust({ certPath });
    if (!ready) {
      throw new Error("Synthetic CA was rejected");
    }
  } else {
    throw new Error("Unknown test mode");
  }
}
process.stdout.write(`${JSON.stringify({ statusCalls })}\n`);
