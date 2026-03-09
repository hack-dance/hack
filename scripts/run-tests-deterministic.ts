import { Glob } from "bun";

const isolatedTestPaths = [
  "tests/node-workspace-bootstrap.test.ts",
  "tests/nodes-registry.test.ts",
] as const;
const maxConcurrencyArg = "--max-concurrency=1";

/**
 * Runs the test suite in deterministic batches to avoid Bun mock.module/env cross-file bleed.
 * Files in isolatedTestPaths must run in their own process before the remaining suite.
 */
async function runTestsDeterministically(): Promise<void> {
  const allTests = await collectTestFiles();
  const remainingTests = allTests.filter(
    (testPath) =>
      !isolatedTestPaths.includes(
        testPath as (typeof isolatedTestPaths)[number]
      )
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

  for (const isolatedTestPath of isolatedTestPaths) {
    if (!files.includes(isolatedTestPath)) {
      throw new Error(`Missing required isolated test: ${isolatedTestPath}`);
    }
  }

  return files;
}

function testLabel(opts: { readonly testPath: string }): string {
  if (opts.testPath === "tests/node-workspace-bootstrap.test.ts") {
    return "bootstrap workspace";
  }
  if (opts.testPath === "tests/nodes-registry.test.ts") {
    return "nodes registry auth";
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
