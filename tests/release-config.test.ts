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

/**
 * `@semantic-release/git` passes the commit message as one `git commit -m`
 * argument. Linux refuses a single argument over 128 KiB (`MAX_ARG_STRLEN`)
 * with E2BIG, and the generated notes for a release that spans a long-lived
 * branch are larger than that (v4.3.1 to the first v5 stable: 227 KB). The
 * notes belong in CHANGELOG.md, which the same commit carries.
 */
test("release commit message does not embed the generated notes", async () => {
  const releaseConfig = (await Bun.file(".releaserc.json").json()) as {
    plugins: readonly (string | readonly [string, Record<string, unknown>])[];
  };
  const git = releaseConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/git"
  );
  expect(Array.isArray(git)).toBe(true);
  const options = (git as readonly [string, Record<string, unknown>])[1];
  const message = String(options.message);
  // Any wording is fine as long as the notes are not part of the argument.
  expect(message).toStartWith("chore(release): ${nextRelease.version}");
  expect(message).not.toContain("nextRelease.notes");
  expect(Buffer.byteLength(message)).toBeLessThan(1024);
  expect(options.assets).toContain("CHANGELOG.md");
});
