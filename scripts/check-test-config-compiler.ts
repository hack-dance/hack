#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import {
  compileNativeConfig,
  resolveNativeConfigCompilerBinary,
} from "../src/lib/native-config-compiler.ts";

const ROOT = resolve(import.meta.dir, "..");
const NAME = "hack-test-preflight";
const INPUT = new TextEncoder().encode(
  JSON.stringify({ schema_version: 1, name: NAME })
);
const SETUP =
  "Compiler prerequisite failed; the CLI suite has not started. " +
  `Select a compatible compiler executable for ${process.platform}/${process.arch}. ` +
  "Prepare this checkout with bun run build:config-compiler, or run the toolchain config-compiler task for Linux container tests. " +
  "An explicit HACK_CONFIG_COMPILER_BINARY must be an absolute compatible executable; it is never replaced by a fallback.";

/** Select the test sidecar before fixtures change their cwd or environment. */
export function resolveTestConfigCompilerBinary(
  opts: { readonly root?: string; readonly override?: string } = {}
): string {
  return resolveNativeConfigCompilerBinary({
    override: opts.override,
    executablePath: resolve(opts.root ?? ROOT, "dist/hack"),
  });
}

/**
 * Read-only protocol/usability prerequisite, not a build-source certification.
 * Sends only fixed synthetic input through the existing bounded, isolated owner.
 */
export async function assertTestConfigCompiler(
  opts: {
    readonly binary?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}
): Promise<void> {
  try {
    const input = Object.freeze({
      binary: opts.binary ?? resolveTestConfigCompilerBinary(),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    const info = await stat(input.binary);
    if (!info.isFile()) {
      throw new Error("Not a regular executable");
    }
    const result = await compileNativeConfig({
      ...input,
      input: INPUT,
      requireLocalResolution: true,
      requireEnvPlanning: true,
      requireHostPlanning: true,
      requireRoutingPlanning: true,
      requireEndpointPlanning: true,
      requireProcessPlanning: true,
      requireAcquisitionPlanning: true,
      requireNetworkPlanning: true,
      requireFilePlanning: true,
    });
    if (
      input.signal?.aborted ||
      !result.ok ||
      result.plan.name !== NAME ||
      !isRecord(result.plan.services) ||
      Object.keys(result.plan.services).length !== 0 ||
      !isRecord(result.plan.jobs) ||
      Object.keys(result.plan.jobs).length !== 0 ||
      !result.declared_workloads ||
      Object.keys(result.declared_workloads).length !== 0
    ) {
      throw new Error("Invalid synthetic compilation");
    }
  } catch {
    throw new Error(SETUP);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let cancelledExit = 0;
  const cancel = (exit: number) => {
    cancelledExit ||= exit;
    controller.abort();
  };
  const interrupt = () => cancel(130);
  const terminate = () => cancel(143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    await assertTestConfigCompiler({ signal: controller.signal });
    if (controller.signal.aborted) {
      process.exitCode = cancelledExit || 1;
    }
  } catch {
    process.stderr.write(`${SETUP}\n`);
    process.exitCode = cancelledExit || 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

if (import.meta.main) {
  await main();
}
