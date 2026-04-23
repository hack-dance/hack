import { Glob } from "bun";

const alwaysIsolatedTestPaths = [
  "tests/node-workspace-bootstrap.test.ts",
  "tests/nodes-registry.test.ts",
  "tests/daemon-sessions.test.ts",
  "tests/daemon-env.test.ts",
  "tests/runtime-backend.test.ts",
  "tests/runtime-projects.test.ts",
  "tests/projects-registry.test.ts",
  "tests/project-run-command.test.ts",
  "tests/project-exec-command.test.ts",
  "tests/session-env-command.test.ts",
] as const;
const maxConcurrencyArg = "--max-concurrency=1";
const mockModulePattern = "mock.module(";

/**
 * Runs the test suite in deterministic batches to avoid Bun mock.module/env cross-file bleed.
 * Files in alwaysIsolatedTestPaths and any test that uses mock.module must run in
 * their own process before the remaining suite.
 */
async function runTestsDeterministically(): Promise<void> {
  const allTests = await collectTestFiles();
  const isolatedTestPaths = await collectIsolatedTestPaths({
    allTests,
  });
  const isolatedTestPathSet = new Set(isolatedTestPaths);
  const remainingTests = allTests.filter(
    (testPath) => !isolatedTestPathSet.has(testPath)
  );

  for (const isolatedTestPath of isolatedTestPaths) {
    await runBunTest({
      label: testLabel({ testPath: isolatedTestPath }),
      testPaths: [isolatedTestPath],
    });
  }
  await runBunTest({
    label: "remaining suite",
    testPaths: remainingTests,
  });
}

/**
 * Collects test files under tests/ in sorted order so command args are stable across machines.
 */
async function collectTestFiles(): Promise<string[]> {
  const glob = new Glob("tests/**/*.test.ts");
  const files: string[] = [];
  for await (const filePath of glob.scan(".")) {
    files.push(filePath);
  }
  files.sort((left, right) => left.localeCompare(right));

  for (const isolatedTestPath of alwaysIsolatedTestPaths) {
    if (!files.includes(isolatedTestPath)) {
      throw new Error(`Missing required isolated test: ${isolatedTestPath}`);
    }
  }

  return files;
}

async function collectIsolatedTestPaths(opts: {
  readonly allTests: readonly string[];
}): Promise<string[]> {
  const isolatedTestPathSet = new Set<string>(alwaysIsolatedTestPaths);

  for (const testPath of opts.allTests) {
    const text = await Bun.file(testPath).text();
    if (text.includes(mockModulePattern)) {
      isolatedTestPathSet.add(testPath);
    }
  }

  const autoIsolatedTestPaths = opts.allTests.filter((testPath) =>
    isolatedTestPathSet.has(testPath)
  );
  const prioritizedIsolatedTestPaths = alwaysIsolatedTestPaths.filter(
    (testPath) => isolatedTestPathSet.has(testPath)
  );

  return [
    ...prioritizedIsolatedTestPaths,
    ...autoIsolatedTestPaths.filter(
      (testPath) =>
        !prioritizedIsolatedTestPaths.includes(
          testPath as (typeof alwaysIsolatedTestPaths)[number]
        )
    ),
  ];
}

function testLabel(opts: { readonly testPath: string }): string {
  if (opts.testPath === "tests/node-workspace-bootstrap.test.ts") {
    return "bootstrap workspace";
  }
  if (opts.testPath === "tests/nodes-registry.test.ts") {
    return "nodes registry auth";
  }
  if (opts.testPath === "tests/daemon-sessions.test.ts") {
    return "daemon sessions";
  }
  if (opts.testPath === "tests/daemon-env.test.ts") {
    return "daemon env routes";
  }
  if (opts.testPath === "tests/runtime-backend.test.ts") {
    return "runtime backend";
  }
  if (opts.testPath === "tests/runtime-projects.test.ts") {
    return "runtime projects";
  }
  if (opts.testPath === "tests/projects-registry.test.ts") {
    return "projects registry";
  }
  if (opts.testPath === "tests/project-run-command.test.ts") {
    return "project run command";
  }
  if (opts.testPath === "tests/project-exec-command.test.ts") {
    return "project exec command";
  }
  if (opts.testPath === "tests/session-env-command.test.ts") {
    return "session env command";
  }
  return opts.testPath;
}

/**
 * Executes `bun test` for a deterministic batch and exits on first failure.
 */
async function runBunTest(opts: {
  readonly label: string;
  readonly testPaths: readonly string[];
}): Promise<void> {
  if (opts.testPaths.length === 0) {
    return;
  }
  const command = ["bun", "test", ...opts.testPaths, maxConcurrencyArg];
  console.log(
    `[tests] running ${opts.label} (${opts.testPaths.length} file(s))`
  );
  const processHandle = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    throw new Error(`bun test failed for ${opts.label} (exit ${exitCode})`);
  }
}

await runTestsDeterministically();
