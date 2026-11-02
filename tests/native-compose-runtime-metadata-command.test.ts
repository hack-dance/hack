import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_HOST_METADATA_KEY_NAMES } from "../src/lib/runtime-host-metadata.ts";
import { fixture, invoke } from "./helpers/native-compose-command.ts";

/**
 * Authored Compose `up` through the real source CLI and `prepareCommand`. The
 * compiler and Docker are stand-ins: the compiler echoes the requested runtime
 * metadata as `runtime` bindings, as the real compiler does, and Docker records
 * the rendered Compose document it was asked to start.
 */

const moved: string[] = [];
afterEach(async () => {
  await Promise.all(
    moved.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

type Engine = {
  readonly name: string;
  readonly services: {
    readonly web: { readonly environment: Record<string, string> };
  };
};

async function engine(root: string): Promise<Engine> {
  return await Bun.file(join(root, "engine")).json();
}

async function composeStarts(root: string): Promise<string[][]> {
  const path = join(root, "requests");
  if (!(await Bun.file(path).exists())) {
    return [];
  }
  return (await Bun.file(path).text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "compose" && args.includes("up"));
}

/** Independent recomputation of the generation store's Compose project identity. */
async function storeComposeProject(
  root: string,
  instance: string | null
): Promise<string> {
  const info = await lstat(root);
  const id = createHash("sha256")
    .update(JSON.stringify([root, info.dev, info.ino, instance]))
    .digest("hex");
  return `hack-nc-${id.slice(0, 32)}`;
}

function generated(environment: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      RUNTIME_HOST_METADATA_KEY_NAMES.includes(key)
    )
  );
}

test.each([
  { name: "default instance", instance: null },
  { name: "branch instance", instance: "feature" },
] as const)("authored Compose up renders runtime metadata with the store's Compose project: $name", async ({
  instance,
}) => {
  const root = await fixture("", false, {
    noHooks: true,
    runtimeMetadata: true,
  });
  const args = [
    "up",
    ...(instance === null ? [] : ["--branch", instance]),
    "--detach",
    "--json",
  ];
  const result = await invoke(root, args);
  expect(result.code).toBe(0);

  const composeProject = await storeComposeProject(root, instance);
  const document = await engine(root);
  // The rendered document is named by the opened store's identity.
  expect(document.name).toBe(composeProject);
  const starts = await composeStarts(root);
  expect(starts).toHaveLength(1);
  expect(starts[0]?.[starts[0].indexOf("-p") + 1]).toBe(composeProject);

  const environment = document.services.web.environment;
  const devHost =
    instance === null ? "fixture.hack.local" : `${instance}.fixture.hack.local`;
  const expected = {
    HACK_BRANCH: instance ?? "",
    HACK_COMPOSE_PROJECT: composeProject,
    HACK_DEV_HOST: devHost,
    HACK_DEV_URL: `https://${devHost}`,
    HACK_SERVICE_NAME: "web",
    HACK_SERVICE_URLS: "[]",
    HACK_RUNTIME_METADATA: JSON.stringify({
      version: 1,
      branch: instance,
      composeProject,
      hosts: { dev: devHost, alias: null },
      services: {},
    }),
  };
  expect(generated(environment)).toEqual(expected);
  // Managed env still delivers beside the generated metadata.
  expect(environment.TOKEN).toBe("global");

  // The compiler planned exactly this selection, once per planning request.
  const requested = (await Bun.file(join(root, "compiler-runtime")).text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  expect(requested.length).toBeGreaterThan(0);
  for (const runtime of requested) {
    expect(runtime).toEqual({ web: expected });
  }
}, 30_000);

test("authored Compose up refuses before any engine effect when the checkout identity changes after metadata selection", async () => {
  const root = await fixture("", false, {
    noHooks: true,
    runtimeMetadata: true,
    // Once, while the first plan request is in flight (after prepareCommand
    // selected the runtime metadata and before it opens the generation store),
    // replace the checkout with a copy: same path, new inode, so the store
    // derives a different Compose project than the metadata reports.
    onPlan: `{const fs=await import("node:fs/promises");const checkout=process.cwd();
  if(!(await Bun.file(checkout+".swapped").exists())){await fs.writeFile(checkout+".swapped","");await fs.rename(checkout,checkout+".moved");await fs.cp(checkout+".moved",checkout,{recursive:true});}}`,
  });
  moved.push(`${root}.moved`, `${root}.swapped`);
  const selected = await storeComposeProject(root, null);

  const result = await invoke(root);

  expect(await Bun.file(`${root}.swapped`).exists()).toBe(true);
  expect(await storeComposeProject(root, null)).not.toBe(selected);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_CONFIG_INVALID",
      message: "The saved native Compose selection is invalid; values omitted.",
    },
  });
  expect(result.stdout).not.toContain(selected);
  expect(await composeStarts(root)).toEqual([]);
  expect(await composeStarts(`${root}.moved`)).toEqual([]);
  expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
}, 30_000);
