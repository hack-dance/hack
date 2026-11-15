import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import packageJson from "../package.json";
import { isRecord } from "../src/lib/guards.ts";
import { verifyStagedReleaseVersion } from "../src/lib/release-version.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";
import { createV4UpgradeFixture } from "./helpers/v4-upgrade-fixture.ts";

const repository = resolve(import.meta.dir, "..");
let buildRoot = "";
let binary = "";
beforeAll(async () => {
  buildRoot = await realpath(
    await mkdtemp(join(tmpdir(), "hack-upgrade-cli-"))
  );
  binary = join(buildRoot, "hack");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "build",
      "tests/fixtures/v4-upgrade-cli.ts",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--outfile",
      binary,
    ],
    {
      cwd: repository,
      env: privateCliEnv({ root: buildRoot }),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    }
  );
  const [code] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error("Current-source upgrade CLI build failed.");
  }
  const fence = Bun.spawn([binary, "--upgrade-fixture-network-check"], {
    env: privateCliEnv({ root: buildRoot }),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  const [fenceCode] = await Promise.all([
    fence.exited,
    new Response(fence.stdout).text(),
    new Response(fence.stderr).text(),
  ]);
  if (fenceCode !== 0) {
    throw new Error("Compiled upgrade CLI network fence was not effective.");
  }
  // Exercise the updater's exact parser with real compiled CLI output.
  await verifyStagedReleaseVersion(binary, packageJson.version);
}, 125_000);
afterAll(async () => {
  if (buildRoot) {
    await rm(buildRoot, { recursive: true, force: true });
  }
});

for (const globalKeyPresent of [true, false]) {
  test(`built CLI upgrades historical v4 state with global key ${globalKeyPresent ? "present" : "lost"}, preserving every live key and value`, async () => {
    const f = await createV4UpgradeFixture({ binary, globalKeyPresent });
    try {
      const keyBefore = await readFile(f.keyPath);
      const storeBefore = await readFile(f.globalStore);
      const configBefore = await readFile(f.globalConfig);
      const legacyBefore = await f.snapshot();
      const doctor = await f.run(["doctor", "--path", f.tracked.path]);
      expect(doctor.output).toContain("migrate-env-config");
      expect(await f.snapshot()).toEqual(legacyBefore);
      if (!globalKeyPresent) {
        // The documented missing-key recovery retires only an unused store;
        // a live decryptable store must never be retired as cleanup.
        expect(
          (await f.run(["secrets", "retire-store", "--path", f.untracked.path]))
            .code
        ).toBe(1);
        expect((await readFile(f.globalStore)).equals(storeBefore)).toBe(true);
        const retire = await f.run([
          "secrets",
          "retire-store",
          "--path",
          f.untracked.path,
          "--yes",
          "--allow-unchecked",
        ]);
        expect(retire.code, retire.output).toBe(0);
      }
      // Env execution can implicitly migrate. Qualify pre-upgrade resolution on
      // an independent byte-equivalent fixture, leaving explicit consent input intact.
      const baseline = await createV4UpgradeFixture({
        binary,
        globalKeyPresent,
      });
      try {
        for (const project of [
          baseline.tracked,
          baseline.untracked,
          baseline.worktree,
        ]) {
          if (project === baseline.worktree) {
            // This route starts with a migrated primary and a legacy linked
            // checkout, then resolves through the normal implicit migration.
            expect(
              await Bun.file(
                join(baseline.tracked.path, ".hack/hack.env.default.yaml")
              ).exists()
            ).toBe(true);
            expect(
              await Bun.file(
                join(baseline.worktree.path, ".hack/hack.env.default.yaml")
              ).exists()
            ).toBe(false);
          }
          const resolution = await baseline.resolveValues(project);
          expect(resolution.code, `${project.path}: ${resolution.output}`).toBe(
            0
          );
        }
      } finally {
        await baseline.dispose();
      }
      const beforeRefusal = await f.snapshot();
      const refused = await f.run([
        "doctor",
        "--path",
        f.tracked.path,
        "--migrate-env-config",
      ]);
      expect(refused.code).toBe(1);
      expect(refused.output).toContain("--accept-tracked-env-changes");
      expect(await f.snapshot()).toEqual(beforeRefusal);
      const beforeApply = new Map([[f.tracked.path, beforeRefusal]]);
      const apply = await f.run([
        "doctor",
        "--path",
        f.tracked.path,
        "--migrate-env-config",
        "--accept-tracked-env-changes",
      ]);
      expect(apply.output).not.toContain("E_INTERACTIVE_REQUIRED");
      // Assertions carry booleans/digests only, including their failure diagnostics.
      expect((await readFile(f.keyPath)).equals(keyBefore)).toBe(true);
      expect(await Bun.file(f.storePath).exists()).toBe(true);
      expect(
        await Bun.file(join(f.tracked.path, ".hack/hack.env.json")).exists(),
        apply.output
      ).toBe(true);
      expect(await Bun.file(join(f.tracked.path, ".hack/.env")).exists()).toBe(
        true
      );
      expect(
        await Bun.file(
          join(f.tracked.path, ".hack/hack.env.default.yaml")
        ).exists()
      ).toBe(true);
      expect(
        await Bun.file(
          join(f.tracked.path, ".hack/hack.env.local.yaml")
        ).exists()
      ).toBe(true);
      expect((await f.resolveValues(f.tracked)).code).toBe(0);
      // Keep explicit consent inputs intact; value probes can implicitly migrate.
      for (const project of [f.worktree, f.untracked]) {
        beforeApply.set(project.path, await f.snapshot());
        const flags =
          project === f.worktree ? ["--accept-tracked-env-changes"] : [];
        const result = await f.run([
          "doctor",
          "--path",
          project.path,
          "--migrate-env-config",
          ...flags,
        ]);
        expect(result.output).not.toContain("E_INTERACTIVE_REQUIRED");
        expect((await f.resolveValues(project)).code).toBe(0);
      }
      // Re-probe the linked value after explicit migration, rather than
      // implicitly migrating it before its consent path is exercised.
      expect((await f.resolveValues(f.worktree)).code).toBe(0);
      expect((await readFile(f.keyPath)).equals(keyBefore)).toBe(true);
      expect((await readFile(f.globalConfig)).equals(configBefore)).toBe(true);
      if (globalKeyPresent) {
        expect((await readFile(f.globalStore)).equals(storeBefore)).toBe(true);
      }
      const stable = await f.snapshot();
      const changed = Object.keys({ ...legacyBefore, ...stable }).filter(
        (name) => legacyBefore[name] !== stable[name]
      );
      const commands = changed.filter((name) =>
        name.startsWith("home/.hack/host-commands/")
      );
      expect(commands.length).toBe(4);
      for (const name of commands) {
        const journal = await readFile(join(f.root, name), "utf8");
        expect(f.sentinels.some((value) => journal.includes(value))).toBe(
          false
        );
      }
      const migrationFiles: string[] = [];
      for (const project of [f.tracked, f.untracked, f.worktree]) {
        const id = createHash("sha256").update(project.path).digest("hex");
        const originals = beforeApply.get(project.path);
        if (!originals) {
          throw new Error("Missing pre-apply fixture observation");
        }
        const journalName = `home/.hack/env-migrations/${id}/journal.json`;
        const journalText = await readFile(join(f.root, journalName), "utf8");
        expect(f.sentinels.some((value) => journalText.includes(value))).toBe(
          false
        );
        const journal: unknown = JSON.parse(journalText);
        if (!(isRecord(journal) && typeof journal.manifestPath === "string")) {
          throw new Error("Expected migration journal metadata");
        }
        expect(journal.state).toBe("complete");
        expect(journal.removed).toEqual([]);
        const manifestName = relative(f.root, journal.manifestPath);
        expect(manifestName).toMatch(
          /^home\/\.hack\/upgrade\/snapshots\/[A-Za-z0-9._-]+\/manifest\.json$/
        );
        const text = await readFile(journal.manifestPath, "utf8");
        expect(f.sentinels.some((value) => text.includes(value))).toBe(false);
        const manifest: unknown = JSON.parse(text);
        if (!(isRecord(manifest) && Array.isArray(manifest.entries))) {
          throw new Error("Expected private snapshot metadata");
        }
        migrationFiles.push(journalName, manifestName);
        for (const entry of manifest.entries) {
          if (
            !(
              isRecord(entry) &&
              typeof entry.path === "string" &&
              isRecord(entry.before)
            )
          ) {
            throw new Error("Expected snapshot original metadata");
          }
          const source = relative(f.root, entry.path);
          let original = originals[source];
          if (
            original === undefined &&
            /^(tracked|untracked|linked)\/(?:\.hack\/)?\.hack-staging\/\.gitignore$/.test(
              source
            ) &&
            entry.before.kind === "file"
          ) {
            original = createHash("sha256").update("*\n").digest("hex");
          }
          // Doctor's secrets hygiene runs before migration's snapshot and
          // creates ignore files. Those fixed housekeeping writes are outside
          // the env migration journal; all other originals match pre-doctor bytes.
          if (
            originals[source] === undefined &&
            [
              "tracked/.gitignore",
              "tracked/.hack/.gitignore",
              "untracked/.hack/.gitignore",
              "linked/.hack/.gitignore",
            ].includes(source)
          ) {
            if (typeof entry.before.sha256 !== "string") {
              throw new Error(
                "Expected snapshot of pre-migration ignore rules"
              );
            }
            const ignore = await readFile(
              join(journal.manifestPath, "..", "blobs", entry.before.sha256)
            );
            const ignoreText = ignore.toString("utf8");
            expect(
              f.sentinels.some((value) => ignoreText.includes(value))
            ).toBe(false);
            const rules = ignoreText
              .split("\n")
              .filter((line) => line !== "" && !line.startsWith("#"));
            if (source === "tracked/.gitignore") {
              expect(rules).toContain(".hack.secret.key");
              expect(rules).toContain("/legacy-store.json");
              expect(
                rules.every((rule) =>
                  [
                    ".hack.secret.key",
                    "/.hack.secret.key",
                    "/legacy-store.json",
                  ].includes(rule)
                )
              ).toBe(true);
            } else {
              expect(ignoreText).toContain(".env");
              expect(
                ignoreText ===
                  "# machine-local secrets (hack doctor --fix)\n.env\n" ||
                  ignoreText.includes("hack.env.local.yaml")
              ).toBe(true);
            }
            original = createHash("sha256").update(ignore).digest("hex");
          }
          if (entry.before.kind === "absent") {
            expect(original, source).toBeUndefined();
            continue;
          }
          expect(entry.before.sha256, source).toBe(original);
          if (typeof entry.before.sha256 !== "string") {
            throw new Error("Expected snapshot original digest");
          }
          const blobName = join(
            manifestName,
            "..",
            "blobs",
            entry.before.sha256
          );
          expect(stable[blobName]).toBe(entry.before.sha256);
          migrationFiles.push(blobName);
        }
      }
      expect(
        changed.filter((name) => migrationFiles.includes(name)).sort()
      ).toEqual([...new Set(migrationFiles)].sort());
      // Private writes keep an empty, self-ignoring stage directory (HACK-2165).
      // Pin these exact effects as well as the migration's payload changes.
      const stagingMarkers = [
        "linked/.hack/.hack-staging/.gitignore",
        "tracked/.hack/.hack-staging/.gitignore",
        "untracked/.hack/.hack-staging/.gitignore",
        "tracked/.hack-staging/.gitignore",
        ...(globalKeyPresent ? ["untracked/.hack-staging/.gitignore"] : []),
      ];
      for (const marker of stagingMarkers) {
        expect(await readFile(join(f.root, marker), "utf8")).toBe("*\n");
        expect(await readdir(join(f.root, marker, ".."))).toEqual([
          ".gitignore",
        ]);
        const [project, ...path] = marker.split("/");
        if (project && project !== "home") {
          await f.git(join(f.root, project), [
            "check-ignore",
            "--quiet",
            path.join("/"),
          ]);
        }
      }
      const expected = [
        ...stagingMarkers,
        "linked/.hack/docker-compose.yml",
        "linked/.hack/.gitignore",
        "tracked/.hack/docker-compose.yml",
        "tracked/.gitignore",
        "tracked/.hack/.gitignore",
        "tracked/.hack/hack.env.default.yaml",
        "tracked/.hack/hack.env.local.yaml",
        "untracked/.hack/docker-compose.yml",
        "untracked/.hack/.gitignore",
        "untracked/.hack/hack.env.default.yaml",
        "untracked/.hack/hack.env.local.yaml",
        ...(globalKeyPresent
          ? ["untracked/.gitignore", "untracked/.hack.secret.key"]
          : [
              "home/.hack/secrets.enc.json",
              "home/.hack/<retired>/secrets.enc.json",
            ]),
      ];
      expect(
        changed
          .filter(
            (name) =>
              !(commands.includes(name) || migrationFiles.includes(name))
          )
          .map((name) =>
            name.startsWith("home/.hack/secrets.enc.json.retired-")
              ? "home/.hack/<retired>/secrets.enc.json"
              : name
          )
          .sort()
      ).toEqual(expected.sort());
      await f.run([
        "doctor",
        "--path",
        f.tracked.path,
        "--migrate-env-config",
        "--accept-tracked-env-changes",
      ]);
      expect(await f.snapshot()).toEqual(stable);
      if (globalKeyPresent) {
        const retire = await f.run([
          "secrets",
          "retire-store",
          "--path",
          f.untracked.path,
          "--yes",
          "--allow-unchecked",
        ]);
        expect(retire.code).toBe(1);
        expect(retire.output).toContain("nothing to retire");
        expect((await readFile(f.globalStore)).equals(storeBefore)).toBe(true);
      } else {
        expect(await Bun.file(f.globalStore).exists()).toBe(false);
        const retired = (await readdir(f.hackHome)).filter((name) =>
          name.includes("retired")
        );
        expect(retired.length).toBe(1);
        expect(
          (
            await readFile(
              join(f.hackHome, retired[0] ?? "missing", "secrets.enc.json")
            )
          ).equals(storeBefore)
        ).toBe(true);
      }
      expect((await readFile(f.keyPath)).equals(keyBefore)).toBe(true);
      if (globalKeyPresent) {
        expect(await Bun.file(f.globalKeyPath).exists()).toBe(true);
      }
      // Migration reads legacy backends but never provisions a replacement key.
      else {
        expect(await Bun.file(f.globalKeyPath).exists()).toBe(false);
      }
      for (const project of [f.tracked, f.untracked, f.worktree]) {
        expect((await f.resolveValues(project)).code).toBe(0);
      }
    } finally {
      await f.dispose();
    }
  }, 120_000);
}
