import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLegacyComposeAdoptionCheckout } from "../src/lib/native-compose-adoption-checkout.ts";
import { acquireNativeConfigImportInputs } from "../src/lib/native-config-import-inputs.ts";
import { restoreEnv } from "./helpers/env.ts";

let root: string;
let primary: string;
let linked: string;
let priorPath: string | undefined;
async function git(cwd: string, args: readonly string[]) {
  const child = Bun.spawn(["/usr/bin/git", "-C", cwd, ...args], {
    env: {
      PATH: priorPath ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await child.exited) !== 0) {
    throw new Error("Git fixture failed; values omitted.");
  }
}
beforeEach(async () => {
  priorPath = process.env.PATH;
  root = await realpath(await mkdtemp(join(tmpdir(), "adoption-checkout-")));
  primary = join(root, "primary");
  linked = join(root, "linked");
  await mkdir(join(primary, ".hack"), { recursive: true });
  await writeFile(
    join(primary, ".hack/hack.config.json"),
    '{"name":"fixture"}'
  );
  await writeFile(
    join(primary, ".hack/docker-compose.yml"),
    "name: fixture\nservices:\n  db:\n    image: fixture:1\n"
  );
  await git(primary, ["init", "--quiet", "-b", "main"]);
  await git(primary, ["add", ".hack"]);
  await git(primary, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await git(primary, ["worktree", "add", "--quiet", "-b", "linked", linked]);
  process.env.PATH = "/usr/bin:/bin";
});
afterEach(async () => {
  restoreEnv("PATH", priorPath);
  await rm(root, { recursive: true, force: true });
});
async function close(
  owner: Awaited<ReturnType<typeof acquireLegacyComposeAdoptionCheckout>>
) {
  await Promise.all(owner.directories.map((held) => held.file.close()));
}
test("linked authority is private, independent of caller redirection, and leaves raw pointers unchanged", async () => {
  const pointer = await readFile(join(linked, ".git"));
  const options = { projectRoot: linked };
  const owner = await acquireLegacyComposeAdoptionCheckout(options);
  try {
    expect(JSON.stringify(owner)).toBe("{}");
    expect(Object.keys(owner)).toEqual([]);
    expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.isFrozen(owner.identity)).toBe(true);
    options.projectRoot = primary;
    await owner.assertFresh();
    expect(await readFile(join(linked, ".git"))).toEqual(pointer);
    expect("kind" in owner.identity && owner.identity.kind).toBe(
      "linked-worktree"
    );
  } finally {
    await close(owner);
  }
});
test.each([
  "marker",
  "backlink",
  "commonLink",
])("raw %s edits refuse without disclosing pointer bytes", async (which) => {
  const owner = await acquireLegacyComposeAdoptionCheckout({
    projectRoot: linked,
  });
  try {
    const path =
      which === "marker"
        ? join(linked, ".git")
        : join(
            primary,
            ".git/worktrees/linked",
            which === "backlink" ? "gitdir" : "commondir"
          );
    await writeFile(path, `${await readFile(path, "utf8")}\n`);
    await expect(owner.assertFresh()).rejects.toThrow("values omitted");
  } finally {
    await close(owner);
  }
});
test("replacing a verified administrative directory refuses while another worktree remains valid", async () => {
  const sibling = join(root, "sibling");
  await git(primary, ["worktree", "add", "--quiet", "-b", "sibling", sibling]);
  const first = await acquireLegacyComposeAdoptionCheckout({
    projectRoot: linked,
  });
  const second = await acquireLegacyComposeAdoptionCheckout({
    projectRoot: sibling,
  });
  try {
    const path = join(primary, ".git/worktrees/linked");
    await rename(path, `${path}-held`);
    await mkdir(path);
    await expect(first.assertFresh()).rejects.toThrow("values omitted");
    await second.assertFresh();
  } finally {
    await close(first);
    await close(second);
  }
});
test("ordinary import preview still refuses Git files while explicit adoption acquisition binds them", async () => {
  expect(
    await acquireNativeConfigImportInputs({ projectRoot: linked })
  ).toMatchObject({ ok: false, code: "git_file_layout_outside_first_slice" });
  const inputs = await acquireNativeConfigImportInputs({
    projectRoot: linked,
    allowLinkedWorktree: true,
  });
  expect(inputs.ok).toBe(true);
  expect(JSON.stringify(inputs)).toBe('{"ok":true}');
  if (!inputs.ok) {
    throw new Error("Fixture adoption acquisition refused");
  }
  await inputs.assertFresh();
  await writeFile(
    join(linked, ".git"),
    `${await readFile(join(linked, ".git"), "utf8")}\n`
  );
  await expect(inputs.assertFresh()).rejects.toThrow("values omitted");
});
test("symlinked Git pointers, redirected roots and aborted reads refuse", async () => {
  const marker = join(linked, ".git");
  await rename(marker, `${marker}-held`);
  await symlink(`${marker}-held`, marker);
  await expect(
    acquireLegacyComposeAdoptionCheckout({ projectRoot: linked })
  ).rejects.toThrow("values omitted");
  const alias = join(root, "alias");
  await symlink(linked, alias);
  await expect(
    acquireLegacyComposeAdoptionCheckout({ projectRoot: alias })
  ).rejects.toThrow("values omitted");
  await expect(
    acquireLegacyComposeAdoptionCheckout({
      projectRoot: primary,
      signal: AbortSignal.abort("synthetic-reason"),
    })
  ).rejects.toThrow("values omitted");
});
