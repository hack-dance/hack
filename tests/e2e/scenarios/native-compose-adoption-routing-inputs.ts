import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPrivate } from "../../../src/lib/native-compose-private-state.ts";
import { resolveProjectOauthAliasHost } from "../../../src/lib/project.ts";

export type RetainedRoutingFixtureSelection = {
  readonly image: string;
  readonly devHost: string;
  readonly aliasHost: string;
  readonly prefer: "alias" | "dev";
  readonly marker: string;
};
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP =
  "Bun.serve({hostname:'0.0.0.0',port:3000,fetch(){return new Response(process.env.RETAINED_ROUTE_MARKER)}})";
function refuse(): never {
  throw new Error("Retained routing fixture input refused; values omitted.");
}

/** Explicit legacy hosts are authored before the original Compose bootstrap. */
export function retainedRoutingFixtureSelection(opts: {
  readonly image: string;
  readonly name: string;
  readonly marker: string;
  readonly prefer: "alias" | "dev";
}): RetainedRoutingFixtureSelection {
  if (!(IMAGE.test(opts.image) && NAME.test(opts.name) && opts.marker)) {
    return refuse();
  }
  const devHost = `${opts.name}.hack.local`;
  const aliasHost = resolveProjectOauthAliasHost({
    devHost,
    oauth: { enabled: true },
  });
  if (!aliasHost || aliasHost === devHost) {
    return refuse();
  }
  return Object.freeze({
    image: opts.image,
    devHost,
    aliasHost,
    prefer: opts.prefer,
    marker: opts.marker,
  });
}

export function retainedRoutingFixtureConfig(
  selection: RetainedRoutingFixtureSelection
) {
  return {
    dev_host: selection.devHost,
    oauth: { enabled: true },
    // Alpha's authored dev preference must lose to its checkout-local alias.
    open: { prefer: "dev" as const },
  };
}
export function retainedRoutingFixtureService(
  selection: RetainedRoutingFixtureSelection
) {
  return {
    image: selection.image,
    pull_policy: "never",
    entrypoint: ["bun", "-e"],
    command: [APP],
    environment: { RETAINED_ROUTE_MARKER: selection.marker },
    networks: ["default", "hack-dev"],
    labels: {
      caddy: `${selection.devHost},${selection.aliasHost}`,
      "caddy.reverse_proxy": "{{upstreams 3000}}",
      "caddy.tls": "internal",
      caddy_ingress_network: "hack-dev",
    },
  };
}
export function retainedRoutingFixtureOrigins(
  selection: RetainedRoutingFixtureSelection
): readonly string[] {
  return [`https://${selection.devHost}`, `https://${selection.aliasHost}`];
}

/** The checkout layer wins without changing either already served origin. */
export async function prepareRetainedRoutingFixtureLocals(opts: {
  readonly primary: { readonly root: string };
  readonly instances: readonly {
    readonly root: string;
    readonly routing?: RetainedRoutingFixtureSelection;
  }[];
}) {
  await writeFile(
    join(opts.primary.root, ".hack/hack.local.json"),
    JSON.stringify({
      schema_version: 1,
      routes: { domain: "primary-shadowed.test" },
      open: { prefer: "dev" },
    }),
    { mode: 0o600 }
  );
  for (const instance of opts.instances) {
    if (!instance.routing) {
      return refuse();
    }
    await writeFile(
      join(instance.root, ".hack/hack.local.json"),
      JSON.stringify({
        schema_version: 1,
        routes: { domain: "checkout-selected.test" },
        open: { prefer: instance.routing.prefer },
      }),
      { mode: 0o600 }
    );
  }
}

/** Private exact sidecar identities and bytes; no digests enter scenario output. */
export async function retainedRoutingFixtureLocalSnapshot(opts: {
  readonly primary: { readonly root: string };
  readonly instance: { readonly root: string };
}) {
  const rows: unknown[] = [];
  for (const checkout of [opts.primary, opts.instance]) {
    const path = join(checkout.root, ".hack/hack.local.json");
    const { info, text } = await readPrivate(path, 4096);
    rows.push({
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      hash: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    });
  }
  return JSON.stringify(rows);
}
