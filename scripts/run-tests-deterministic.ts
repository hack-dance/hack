import { Glob } from "bun";

const bootstrapTestPath = "tests/node-workspace-bootstrap.test.ts";
const maxConcurrencyArg = "--max-concurrency=1";

/**
 * Runs the test suite in deterministic batches to avoid Bun mock.module cross-file bleed.
 * The bootstrap test must run in a clean process before suites that mock shared modules.
 */
async function runTestsDeterministically(): Promise<void> {
  const allTests = await collectTestFiles();
  const remainingTests = allTests.filter(
    (testPath) => testPath !== bootstrapTestPath
  );

  await runBunTest({
    label: "bootstrap workspace",
    testPaths: [bootstrapTestPath],
  });
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

  if (!files.includes(bootstrapTestPath)) {
    throw new Error(`Missing required bootstrap test: ${bootstrapTestPath}`);
  }

  return files;
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
