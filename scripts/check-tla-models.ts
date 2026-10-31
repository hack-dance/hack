#!/usr/bin/env bun
// Generic runner restored from c15fd8117547a11148f540ae9bbc0b4baf9c30b9;
// property catalogs and domain-specific result checks are intentionally external.
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { CHECKS, type TlaCheck } from "./lib/tla-checks.ts";
import { type TlaExpectation, verifyTlaResult } from "./lib/tla-result.ts";
import {
  resolveTlaJar,
  runTlaProcess,
  TLA_JAVA_FLAGS,
  TLA_LAUNCHER,
  TLA_TOOL,
  withTlaScratch,
} from "./lib/tla-toolchain.ts";

type TlaRun = {
  readonly check: TlaCheck;
  readonly config: string;
  readonly expected: TlaExpectation;
  readonly phase: string;
};

export function validateTlaChecks(checks: readonly TlaCheck[]): void {
  if (checks.length === 0) {
    throw new Error("TLA+ manifest is empty; verification is blocked.");
  }
  const ids = new Set<string>();
  for (const check of checks) {
    if (!check.id || ids.has(check.id)) {
      throw new Error(`Missing or duplicate TLA+ check id: ${check.id}.`);
    }
    ids.add(check.id);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(check.mutation.expected.property)) {
      throw new Error(`Invalid property name for ${check.id}.`);
    }
    validateCheckPaths(check);
    if (
      !check.mutation.config.includes("/mutations/") ||
      check.mutation.config === check.baseline.config
    ) {
      throw new Error(`Missing separate mutation config for ${check.id}.`);
    }
    if (check.baseline.expected.kind !== "pass") {
      if (!check.reference) {
        throw new Error(
          `Known finding ${check.id} needs a passing reference control.`
        );
      }
      if (
        check.baseline.expected.kind !== check.mutation.expected.kind ||
        check.baseline.expected.property !== check.mutation.expected.property
      ) {
        throw new Error(
          `Baseline and mutation must check the same property for ${check.id}.`
        );
      }
    }
  }
}

function validateCheckPaths(check: TlaCheck): void {
  const configs = [check.baseline, check.mutation, ...passingControls(check)];
  for (const path of [
    check.module,
    ...configs.map((config) => config.config),
  ]) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      throw new Error(`TLA+ paths must be repository-relative: ${path}.`);
    }
  }
  if (
    !check.module.endsWith(".tla") ||
    configs.some((config) => !config.config.endsWith(".cfg"))
  ) {
    throw new Error(`Expected .tla module and .cfg configs for ${check.id}.`);
  }
}

function passingControls(check: TlaCheck) {
  return [
    ...(check.reference ? [check.reference] : []),
    ...(check.controls ?? []),
  ];
}

export async function runTlaSequence(opts: {
  readonly checks: readonly TlaCheck[];
  readonly runCheck: (run: TlaRun) => Promise<void>;
  readonly runReplays: () => Promise<void>;
}): Promise<void> {
  validateTlaChecks(opts.checks);
  const baselines = async (phase: string) => {
    for (const check of opts.checks) {
      await opts.runCheck({ check, ...check.baseline, phase });
      for (const control of passingControls(check)) {
        await opts.runCheck({ check, ...control, phase: `${phase} control` });
      }
    }
  };
  await baselines("baseline");
  for (const check of opts.checks) {
    await opts.runCheck({ check, ...check.mutation, phase: "mutation" });
  }
  await opts.runReplays();
  await baselines("restored baseline");
}

async function copyModelSources(opts: {
  source: string;
  target: string;
}): Promise<void> {
  for await (const file of new Bun.Glob("**/*.{tla,cfg}").scan({
    cwd: opts.source,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    const target = resolve(opts.target, file);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, Bun.file(resolve(opts.source, file)));
  }
}

export async function runTlaModel(
  opts: TlaRun & {
    readonly root: string;
    readonly jar: string;
    readonly java: string;
  }
): Promise<void> {
  await withTlaScratch(async (scratch) => {
    const source = dirname(resolve(opts.root, opts.check.module));
    const configPath = relative(source, resolve(opts.root, opts.config));
    if (configPath.startsWith("..") || isAbsolute(configPath)) {
      throw new Error(`Config must be in the model directory: ${opts.config}.`);
    }
    const directory = resolve(scratch, "source");
    await copyModelSources({ source, target: directory });
    const module = resolve(
      directory,
      relative(source, resolve(opts.root, opts.check.module))
    );
    const config = resolve(directory, configPath);
    if (
      !((await Bun.file(module).exists()) && (await Bun.file(config).exists()))
    ) {
      throw new Error(
        `Missing module or config for ${opts.check.id}: ${opts.config}.`
      );
    }
    const launcher = resolve(scratch, "CheckedTlc.java");
    await Bun.write(launcher, TLA_LAUNCHER);
    const javaTmp = resolve(scratch, "tmp");
    await mkdir(javaTmp);
    const { kind, property } = opts.check.mutation.expected;
    const result = await runTlaProcess({
      cwd: directory,
      command: [
        opts.java,
        ...TLA_JAVA_FLAGS,
        `-Djava.io.tmpdir=${javaTmp}`,
        "-cp",
        opts.jar,
        launcher,
        kind,
        property,
        config,
        "-tool",
        "-workers",
        "1",
        "-fp",
        "0",
        "-seed",
        "1",
        "-metadir",
        resolve(scratch, "states"),
        "-config",
        config,
        module,
      ],
    });
    process.stdout.write(result.output);
    if (
      !(
        result.output.includes(TLA_TOOL.banner) &&
        verifyTlaResult({ ...result, expected: opts.expected })
      )
    ) {
      throw new Error(
        `${opts.check.id} ${opts.phase} rejected (exit=${result.exitCode}, interrupted=${result.failed}): ${opts.config}.`
      );
    }
    const outcome =
      opts.expected.kind === "pass"
        ? "pass"
        : `expected ${opts.expected.kind} violation of ${opts.expected.property}`;
    process.stdout.write(
      `${opts.check.id} ${opts.phase}: ${outcome}; exit=${result.exitCode}\n`
    );
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--download")) {
    throw new Error("Usage: bun scripts/check-tla-models.ts [--download]");
  }
  if (Bun.version !== "1.3.9") {
    throw new Error(`Use the pinned Bun 1.3.9; running ${Bun.version}.`);
  }
  validateTlaChecks(CHECKS);
  const root = resolve(import.meta.dir, "..");
  const jar = await resolveTlaJar({
    root,
    override: process.env.TLA2TOOLS_JAR,
    download: args.includes("--download"),
  });
  const java = process.env.JAVA_BIN ?? "java";
  const version = await runTlaProcess({
    command: [java, "-version"],
    cwd: root,
  });
  if (
    version.failed ||
    version.exitCode !== 0 ||
    !/version "17(?:\.|")/.test(version.output)
  ) {
    throw new Error(
      `Java 17 is required; set JAVA_BIN or use mise exec.\n${version.output}`
    );
  }
  process.stdout.write(
    `TLA+ jar=${jar}\nsha256=${TLA_TOOL.sha256}\n${version.output}\n`
  );
  await runTlaSequence({
    checks: CHECKS,
    runCheck: (run) => runTlaModel({ ...run, root, jar, java }),
    runReplays: async () => {
      const result = await runTlaProcess({
        command: [process.execPath, "scripts/check-supervisor-replays.ts"],
        cwd: root,
      });
      process.stdout.write(result.output);
      if (result.failed || result.exitCode !== 0) {
        throw new Error(
          `Supervisor replay/sensitivity checks failed (exit=${result.exitCode}, interrupted=${result.failed}).`
        );
      }
    },
  });
  process.stdout.write(
    "TLC expectations, mutation controls, replays, and restored baselines verified. Expected findings remain findings.\n"
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
