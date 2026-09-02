import { expect, test } from "bun:test";

test("release config recognizes bang syntax as a breaking change", async () => {
  const analyzer = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `
        import { analyzeCommits } from "@semantic-release/commit-analyzer";
        const releaseConfig = await Bun.file(".releaserc.json").json();
        const analyzerConfig = releaseConfig.plugins[0][1];
        const logger = { log() {} };
        const releaseType = await analyzeCommits(analyzerConfig, {
          commits: [{ hash: "breaking-commit", message: "feat!: remove a retired surface" }],
          cwd: process.cwd(),
          logger,
        });
        console.log(releaseType);
      `,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    analyzer.exited,
    new Response(analyzer.stdout).text(),
    new Response(analyzer.stderr).text(),
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("major");
});
