import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveModernComposeEnvOverrides,
  resolveRuntimeHostMetadataOverride,
} from "../../../src/commands/project.ts";
import { renderManagedComposeEnvOverride } from "../../../src/lib/compose-managed-env.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContextAtRoot,
} from "../../../src/lib/project.ts";
import {
  setProjectEnvValue,
  unsetProjectEnvValue,
} from "../../../src/lib/project-env-config.ts";
import { buildRuntimeHostMetadataOverride } from "../../../src/lib/runtime-host-metadata.ts";

export const MANAGED_FIXTURE_VALUE = "nc04-synthetic-managed-private-value";
type Checkout = { readonly root: string; readonly name: string };
const HOME_KEYS = [
  "HOME",
  "HACK_HOME",
  "CI",
  "HACK_EXECUTION_MODE",
  "HACK_ENV_SECRET_KEY",
] as const;
const LAYERS = [
  "hack.env.default.yaml",
  "hack.env.qa.yaml",
  "hack.env.local.yaml",
  "hack.env.qa.local.yaml",
] as const;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function refuse(): never {
  throw new Error(
    "Adoption managed fixture source check failed; values omitted."
  );
}

/** The file vector is derived from fixture-owned roots, never an arbitrary override argument. */
export function managedAdoptionFixtureComposeFiles(
  root: string
): readonly string[] {
  return Object.freeze([
    join(root, ".hack/docker-compose.yml"),
    join(root, ".hack/.internal/compose.runtime.override.yml"),
    join(root, ".hack/.internal/compose.env.override.yml"),
  ]);
}

/** Direct existing writers use the same isolated home/policy as the later compiled CLI. */
async function withFixtureHome<T>(opts: {
  readonly hackHome: string;
  readonly tempRoot: string;
  readonly run: () => Promise<T>;
}): Promise<T> {
  const previous = Object.fromEntries(
    HOME_KEYS.map((key) => [key, process.env[key]])
  );
  const writerHome = join(opts.tempRoot, "managed-writer-home");
  await mkdir(writerHome, { recursive: true, mode: 0o700 });
  process.env.HOME = writerHome;
  process.env.HACK_HOME = opts.hackHome;
  process.env.CI = "";
  process.env.HACK_EXECUTION_MODE = "";
  Reflect.deleteProperty(process.env, "HACK_ENV_SECRET_KEY");
  try {
    return await opts.run();
  } finally {
    for (const key of HOME_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function set(opts: {
  readonly root: string;
  readonly envName?: string | null;
  readonly local?: boolean;
  readonly scope?: string;
  readonly key: string;
  readonly value: string;
  readonly secret?: boolean;
}) {
  await setProjectEnvValue({
    projectRoot: opts.root,
    projectDir: join(opts.root, ".hack"),
    envName: opts.envName ?? null,
    scope: opts.scope ?? "global",
    key: opts.key,
    value: opts.value,
    secret: opts.secret ?? false,
    local: opts.local,
  });
}

/** Synthetic input setup only: existing mutation/writer owners, real context, no engine/global startup or manual managed-internal writes. */
export async function prepareManagedAdoptionFixtureSources(opts: {
  readonly hackHome: string;
  readonly tempRoot: string;
  readonly primary: Checkout;
  readonly instances: readonly Checkout[];
}) {
  await withFixtureHome({
    ...opts,
    run: async () => {
      for (const [envName, localValues] of [
        [
          null,
          {
            NC04_ORDER: "primary",
            NC04_PRIMARY: "primary",
            NC04_DROP: "primary",
          },
        ],
        ["qa", { NC04_ORDER: "primary-qa", NC04_PRIMARY_QA: "primary-qa" }],
      ] as const) {
        for (const [key, value] of Object.entries(localValues)) {
          await set({
            root: opts.primary.root,
            envName,
            local: true,
            key,
            value,
          });
        }
      }
      for (const instance of opts.instances) {
        for (const [key, value] of Object.entries({
          NC04_ORDER: "default",
          NC04_DEFAULT: "default",
          NC04_DROP: "default",
          NC04_EMPTY: "",
        })) {
          await set({ root: instance.root, key, value });
        }
        await set({
          root: instance.root,
          envName: "qa",
          key: "NC04_ORDER",
          value: "overlay",
        });
        await set({
          root: instance.root,
          local: true,
          key: "NC04_ORDER",
          value: "current",
        });
        await set({
          root: instance.root,
          local: true,
          key: "NC04_CURRENT",
          value: instance.name,
        });
        await set({
          root: instance.root,
          local: true,
          envName: "qa",
          key: "NC04_ORDER",
          value: `${instance.name}-qa`,
        });
        await set({
          root: instance.root,
          local: true,
          envName: "qa",
          key: "NC04_EMPTY",
          value: "",
        });
        await unsetProjectEnvValue({
          projectRoot: instance.root,
          projectDir: join(instance.root, ".hack"),
          envName: "qa",
          local: true,
          scope: "global",
          key: "NC04_DROP",
        });
        await set({
          root: instance.root,
          key: "NC04_SECRET",
          value: `${MANAGED_FIXTURE_VALUE}-${instance.name}`,
          secret: true,
        });
        for (const scope of ["db", "worker"]) {
          await set({
            root: instance.root,
            envName: "qa",
            scope,
            key: "NC04_SCOPE",
            value: `${scope}-qa`,
          });
        }
        await writeGenerated(instance);
      }
    },
  });
}

async function writeGenerated(instance: Checkout) {
  const project = await findProjectContextAtRoot({
    projectRoot: instance.root,
    projectDirName: ".hack",
  });
  if (!project) {
    refuse();
  }
  const composeText = await readFile(project.composeFile, "utf8");
  const runtimeOpts = {
    composeYamls: [composeText],
    branch: null,
    devHost: `${defaultProjectSlugFromPath(instance.root)}.hack`,
    aliasHost: null,
    composeProject: instance.name,
  };
  const runtime = await resolveRuntimeHostMetadataOverride({
    project,
    composeFiles: [project.composeFile],
    ...runtimeOpts,
  });
  const managed = await resolveModernComposeEnvOverrides({
    project,
    targetServices: ["db", "worker"],
    allServiceNames: ["db", "worker"],
    envName: "qa",
  });
  const files = managedAdoptionFixtureComposeFiles(instance.root);
  if (
    !(
      managed &&
      runtime === files[1] &&
      JSON.stringify(managed.composeFiles) === JSON.stringify(files.slice(2)) &&
      managed.env.NC04_ORDER === `${instance.name}-qa` &&
      managed.env.NC04_EMPTY === "" &&
      managed.env.NC04_DROP === undefined
    )
  ) {
    refuse();
  }
  const expectedRuntime = buildRuntimeHostMetadataOverride(runtimeOpts);
  const expectedEnv = renderManagedComposeEnvOverride({
    targetServices: ["db", "worker"],
    globalEnv: managed.env,
    serviceEnv: managed.preflightEnvByService,
  });
  if (
    (await readFile(runtime, "utf8")) !== expectedRuntime ||
    (await readFile(files[2] ?? "", "utf8")) !== expectedEnv
  ) {
    refuse();
  }
}

/** Private byte/inode oracle covers selected raw layers, shared primary locals and original generated files throughout adoption. */
export async function managedAdoptionFixtureSourceSnapshot(opts: {
  readonly primary: Checkout;
  readonly instance: Checkout;
}): Promise<string> {
  const paths = [
    ...LAYERS.map((name) => join(opts.instance.root, ".hack", name)),
    ...LAYERS.slice(2).map((name) => join(opts.primary.root, ".hack", name)),
    ...managedAdoptionFixtureComposeFiles(opts.instance.root).slice(1),
    join(opts.primary.root, ".hack/hack.config.json"),
    join(opts.primary.root, ".hack/docker-compose.yml"),
  ];
  const files: { path: string; dev: number; ino: number; hash: string }[] = [];
  for (const path of paths) {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) {
      refuse();
    }
    files.push({
      path,
      dev: info.dev,
      ino: info.ino,
      hash: new Bun.CryptoHasher("sha256")
        .update(await readFile(path))
        .digest("hex"),
    });
  }
  return JSON.stringify(files);
}

/** Fixed synthetic assertions return no environment values and inspect only retained original IDs. */
export function managedAdoptionFixtureEnvAssertion(
  instance: Checkout,
  service: "db" | "worker"
): string {
  if (!(NAME.test(instance.name) && ["db", "worker"].includes(service))) {
    refuse();
  }
  return [
    'test "$NC04_DEFAULT" = default',
    'test "$NC04_PRIMARY" = primary',
    'test "$NC04_PRIMARY_QA" = primary-qa',
    `test "$NC04_CURRENT" = ${instance.name}`,
    `test "$NC04_ORDER" = ${instance.name}-qa`,
    'test "${NC04_EMPTY+x}" = x',
    'test -z "$NC04_EMPTY"',
    'test -z "${NC04_DROP+x}"',
    `test "$NC04_SCOPE" = ${service}-qa`,
    `test "$NC04_SECRET" = ${MANAGED_FIXTURE_VALUE}-${instance.name}`,
  ].join(" && ");
}
