import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMacTrustForPlan } from "../src/commands/global-mac-trust.ts";
import type { ExecOptions, ExecResult } from "../src/lib/shell.ts";
import { CURRENT_CA_PEM } from "./helpers/ca-certificates.ts";

type ProbeCase = {
  readonly name: string;
  readonly listed: number | "throws";
  readonly verified?: number;
  readonly status: "unknown" | "ready" | "trusted";
};

test.each<ProbeCase>([
  { name: "list timeout", listed: 124, status: "unknown" },
  { name: "list cannot start", listed: 127, status: "unknown" },
  { name: "list spawn throws", listed: "throws", status: "unknown" },
  { name: "verification timeout", listed: 0, verified: 124, status: "unknown" },
  {
    name: "verification cannot start",
    listed: 0,
    verified: 127,
    status: "unknown",
  },
  { name: "missing root", listed: 1, status: "ready" },
  { name: "verified root", listed: 0, verified: 0, status: "trusted" },
])("plan-only keychain reads preserve $name and bound every probe", async (scenario) => {
  const directory = await mkdtemp(join(tmpdir(), "hack-keychain-plan-"));
  try {
    const certPath = join(directory, "root.crt");
    await Bun.write(certPath, CURRENT_CA_PEM);
    const calls: {
      readonly argv: readonly string[];
      readonly opts?: ExecOptions;
    }[] = [];
    const execute = async (
      argv: readonly string[],
      opts?: ExecOptions
    ): Promise<ExecResult> => {
      calls.push({ argv, opts });
      expect(argv[0]).toBe("security");
      if (scenario.listed === "throws") {
        throw new Error("fixture spawn unavailable");
      }
      return argv[1] === "find-certificate"
        ? {
            exitCode: scenario.listed,
            stdout: scenario.listed === 0 ? CURRENT_CA_PEM : "",
            stderr: "",
          }
        : { exitCode: scenario.verified ?? 0, stdout: "", stderr: "" };
    };
    const planned = await prepareMacTrustForPlan({
      certPath,
      timeoutMs: 50,
      execute,
    });
    expect(planned.status).toBe(scenario.status);
    expect(calls.length).toBe(scenario.listed === 0 ? 2 : 1);
    for (const call of calls) {
      expect(call.opts).toMatchObject({ stdin: "ignore", timeoutMs: 50 });
    }
    if (planned.status === "unknown") {
      expect("argv" in planned).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ineligible CA needs no keychain probe during planning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hack-keychain-plan-"));
  try {
    const certPath = join(directory, "root.crt");
    await Bun.write(certPath, "invalid public certificate fixture");
    const planned = await prepareMacTrustForPlan({
      certPath,
      timeoutMs: 50,
      execute: () => {
        throw new Error("An ineligible CA must not reach a keychain probe");
      },
    });
    expect(planned.status).toBe("ineligible");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
