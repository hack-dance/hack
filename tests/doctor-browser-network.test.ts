import { expect, test } from "bun:test";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import {
  checkBrowserLocalNetwork,
  parseBrowserNetworkOptions,
  probeBrowserTarget,
} from "../src/lib/doctor-browser-network.ts";

const url = "https://app.hack/";

test("browser observation is unknown by default and requires an exact safe origin", () => {
  expect(parseBrowserNetworkOptions({})).toEqual({
    url: null,
    observation: "unknown",
  });
  expect(
    parseBrowserNetworkOptions({ url: "https://app.hack", result: "works" })
  ).toEqual({ url, observation: "works" });
  for (const input of [
    { result: "healthy" },
    { result: "works" },
    ...[
      "http://app.hack",
      "https://user:secret@app.hack",
      "https://app.hack/?token=secret",
      "https://app.hack/#secret",
      "https://app.hack/path",
      "https://app.hack\n",
    ].map((invalid) => ({ url: invalid })),
  ]) {
    expect(() => parseBrowserNetworkOptions(input)).toThrow();
  }
});

test("non-macOS and missing targets never probe or claim browser health", async () => {
  const probe = () => {
    throw new Error("must not execute");
  };
  expect(
    (
      await checkBrowserLocalNetwork({
        platform: "linux",
        url,
        observation: "fails",
        probe,
      })
    ).message
  ).toContain("Not applicable");
  const missing = await checkBrowserLocalNetwork({
    platform: "darwin",
    url: null,
    observation: "unknown",
    probe,
  });
  expect(missing.status).toBe("warn");
  expect(missing.message).toContain("unverified");
});

test("CLI success does not replace manual observation or prove permission state", async () => {
  const probe = async (target: string) => {
    expect(target).toBe(url);
    return { outcome: "response" as const, status: 200 };
  };
  const unknown = await checkBrowserLocalNetwork({
    platform: "darwin",
    url,
    observation: "unknown",
    probe,
  });
  expect(unknown.status).toBe("warn");
  expect(unknown.message).toContain("unverified");
  const works = await checkBrowserLocalNetwork({
    platform: "darwin",
    url,
    observation: "works",
    probe,
  });
  expect(works.status).toBe("ok");
  expect(works.message).toContain("manual observation");
  const failed = await checkBrowserLocalNetwork({
    platform: "darwin",
    url,
    observation: "fails",
    probe,
  });
  expect(failed.status).toBe("warn");
  expect(failed.message).toContain("possible cause (not confirmed)");
  expect(failed.message).toContain("recheck this same origin");
  const denied = await checkBrowserLocalNetwork({
    platform: "darwin",
    url,
    observation: "permission-denied",
    probe,
  });
  expect(denied.message).toContain("You reported a browser permission denial");
  expect(denied.message).toContain(
    "does not inspect or change privacy settings"
  );
});

test("TLS failure and HTTP errors stay ambiguous even with reported denial", async () => {
  for (const result of [
    { outcome: "failed" as const },
    { outcome: "response" as const, status: 302 },
    { outcome: "response" as const, status: 403 },
    { outcome: "response" as const, status: 503 },
  ]) {
    const report = await checkBrowserLocalNetwork({
      platform: "darwin",
      url,
      observation: "permission-denied",
      probe: async () => result,
    });
    expect(report.status).toBe("warn");
    expect(report.message).toContain("Cannot isolate a browser-only failure");
  }
});

test("curl invocation validates TLS, disables config, and bounds transfer without following redirects", async () => {
  const result = await probeBrowserTarget(url, async (argv, options) => {
    expect(argv[1]).toBe("--disable");
    expect(argv).toContain("--max-time");
    expect(argv).toContain("--max-filesize");
    expect(argv).toContain("/dev/null");
    expect(argv).not.toContain("--insecure");
    expect(argv).not.toContain("-k");
    expect(argv).not.toContain("--location");
    expect(argv.at(-1)).toBe(url);
    expect(options?.timeoutMs).toBe(6000);
    return { exitCode: 0, stdout: "302", stderr: "" };
  });
  expect(result).toEqual({ outcome: "response", status: 302 });
  for (const output of [
    { exitCode: 60, stdout: "000", stderr: "private diagnostic" },
    { exitCode: 0, stdout: "200garbage", stderr: "" },
  ]) {
    expect(await probeBrowserTarget(url, async () => output)).toEqual({
      outcome: "failed",
    });
  }
});

test("invalid browser arguments fail before Doctor invokes tools", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "index.ts",
      "doctor",
      "--browser-result",
      "works",
      "--json",
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 5000 }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).not.toBe(0);
  expect(stdout).not.toContain("docker");
  expect(stdout + stderr).toContain("requires --browser-url");
});

test("JSON and summary retain the unknown browser warning separately", async () => {
  const check = await checkBrowserLocalNetwork({
    platform: "darwin",
    url: null,
    observation: "unknown",
  });
  const data = buildDoctorJsonData({ results: [{ ...check, durationMs: 0 }] });
  expect(data.checks[0]?.status).toBe("warn");
  expect(data.checks[0]?.detail).toContain("unverified");
  expect(data.summary.join(" ")).toContain("Browser access");
});
