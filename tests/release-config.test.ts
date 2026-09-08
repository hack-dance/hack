import { expect, test } from "bun:test";

test("release config analyzes and renders bang breaking changes", async () => {
  const releaseProbe = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `
        import { analyzeCommits } from "@semantic-release/commit-analyzer";
        import { generateNotes } from "@semantic-release/release-notes-generator";
        const releaseConfig = await Bun.file(".releaserc.json").json();
        const analyzerConfig = releaseConfig.plugins[0][1];
        const notesConfig = releaseConfig.plugins[1][1];
        const logger = { log() {} };
        const commits = [
          { hash: "breaking-commit", message: "feat!: remove a retired surface" },
        ];
        const releaseType = await analyzeCommits(analyzerConfig, {
          commits,
          cwd: process.cwd(),
          logger,
        });
        const notes = await generateNotes(notesConfig, {
          commits,
          cwd: process.cwd(),
          lastRelease: { gitTag: "v3.5.2" },
          nextRelease: { gitTag: "v4.0.0", version: "4.0.0" },
          options: { repositoryUrl: "https://github.com/hack-dance/hack.git" },
        });
        console.log(JSON.stringify({ notes, releaseType }));
      `,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    releaseProbe.exited,
    new Response(releaseProbe.stdout).text(),
    new Response(releaseProbe.stderr).text(),
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const result = JSON.parse(stdout) as {
    notes: string;
    releaseType: string;
  };
  expect(result.releaseType).toBe("major");
  expect(result.notes).toContain("BREAKING CHANGES");
  expect(result.notes).toContain("remove a retired surface");
});
