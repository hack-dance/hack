import { isRecord } from "./guards.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

type Attachment = { readonly aliases?: readonly string[] };
type Attachments = Readonly<Record<string, Attachment>>;
type OwnedNetwork = {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly driver?: "bridge";
  readonly internal?: boolean;
};

export type NativeComposeNetworks = {
  readonly definitions: Readonly<Record<string, OwnedNetwork>>;
  /** Null retains the legacy implicit-default Compose representation. */
  readonly workloads: Readonly<Record<string, Attachments | null>>;
};

export class NativeComposeNetworkError extends Error {
  constructor() {
    super("Native project network topology is invalid.");
    this.name = "NativeComposeNetworkError";
  }
}

function requireValue(value: unknown): asserts value {
  if (!value) {
    throw new NativeComposeNetworkError();
  }
}

function named(value: string): boolean {
  return NAME.test(value);
}

function internalPolicy(value: Record<string, unknown>): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, "internal");
  requireValue(
    descriptor &&
      Object.hasOwn(descriptor, "value") &&
      typeof descriptor.value === "boolean"
  );
  return descriptor.value;
}

/** Closed, effect-free topology binding before private environment delivery. */
export function prepareNativeComposeNetworks(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly workloads: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly runtimeIdentity: string;
  readonly labels: Readonly<Record<string, string>>;
}): NativeComposeNetworks {
  const declarations = Object.hasOwn(opts.plan, "networks")
    ? opts.plan.networks
    : {};
  requireValue(isRecord(declarations));
  for (const [name, value] of Object.entries(declarations)) {
    requireValue(
      named(name) &&
        name !== "default" &&
        name !== "ingress" &&
        isRecord(value) &&
        Object.keys(value).every((key) => key === "internal")
    );
    internalPolicy(value);
  }
  const used = new Set<string>();
  const seenAliases = new Map<string, Set<string>>();
  const workloadNames = new Set(Object.keys(opts.workloads));
  const workloads = Object.fromEntries(
    Object.entries(opts.workloads).map(([name, workload]) => {
      if (!Object.hasOwn(workload, "networks")) {
        used.add("default");
        return [name, null] as const;
      }
      const value = workload.networks;
      requireValue(isRecord(value) && Object.keys(value).length > 0);
      const attachments = Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([network, attachment]) => {
            requireValue(
              named(network) &&
                (network === "default" ||
                  Object.hasOwn(declarations, network)) &&
                isRecord(attachment) &&
                Object.keys(attachment).every((key) => key === "aliases")
            );
            used.add(network);
            if (!Object.hasOwn(attachment, "aliases")) {
              return [network, {}];
            }
            const aliases = attachment.aliases;
            requireValue(
              Array.isArray(aliases) &&
                aliases.every(
                  (alias) => typeof alias === "string" && named(alias)
                ) &&
                new Set(aliases).size === aliases.length
            );
            const seen = seenAliases.get(network) ?? new Set<string>();
            for (const alias of aliases) {
              requireValue(!(workloadNames.has(alias) || seen.has(alias)));
              seen.add(alias);
            }
            seenAliases.set(network, seen);
            return [network, { aliases: [...aliases].sort() }];
          })
      );
      return [name, attachments] as const;
    })
  );
  const definitions = Object.fromEntries(
    [...used].sort().map((name) => {
      if (name === "default") {
        return [
          name,
          {
            name: `${opts.runtimeIdentity}_default`,
            labels: { ...opts.labels },
          },
        ];
      }
      const declaration = declarations[name];
      requireValue(isRecord(declaration));
      return [
        name,
        {
          name: `hack-net-${opts.runtimeIdentity.length}-${opts.runtimeIdentity}-${name.length}-${name}`,
          labels: { ...opts.labels },
          driver: "bridge" as const,
          internal: internalPolicy(declaration),
        },
      ];
    })
  );
  return { definitions, workloads };
}

export function nativeComposeWorkloadsShareNetwork(
  topology: NativeComposeNetworks,
  source: string,
  target: string
): boolean {
  if (
    !(
      Object.hasOwn(topology.workloads, source) &&
      Object.hasOwn(topology.workloads, target)
    )
  ) {
    return false;
  }
  const attached = (name: string) =>
    Object.keys(topology.workloads[name] ?? { default: {} });
  const targets = new Set(attached(target));
  return attached(source).some((name) => targets.has(name));
}
