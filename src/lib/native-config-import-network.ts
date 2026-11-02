import { isRecord } from "./guards.ts";
import { importPointer } from "./native-config-import-parser.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type LegacyOwnedNetworkIntent = {
  readonly logical: string;
  readonly name: string;
  readonly internal: boolean;
  readonly attachments: readonly {
    readonly service: string;
    readonly aliases: readonly string[];
  }[];
};
export type LegacyOwnedNetworksIntent = {
  readonly networks: readonly {
    readonly logical: string;
    readonly name: string;
    readonly internal: boolean;
  }[];
  readonly attachments: readonly {
    readonly service: string;
    readonly networks: readonly {
      readonly logical: string;
      readonly aliases: readonly string[];
    }[];
  }[];
};
export type NetworkMapping =
  | { readonly kind: "omitted" }
  | {
      readonly kind: "refused";
      readonly pointer: string;
      readonly code: string;
    }
  | {
      readonly kind: "owned";
      readonly intent: LegacyOwnedNetworkIntent;
      readonly pointers: readonly {
        readonly source: string;
        readonly target: string;
        readonly code: string;
      }[];
    }
  | {
      readonly kind: "multiple";
      readonly intent: LegacyOwnedNetworksIntent;
      readonly pointers: readonly {
        readonly source: string;
        readonly target: string;
        readonly code: string;
      }[];
    };

function validName(value: string): boolean {
  return value.length <= 63 && NAME.test(value);
}

function refuse(pointer: string, code: string): NetworkMapping {
  return { kind: "refused", pointer, code };
}

function attachment(opts: {
  readonly source: unknown;
  readonly logical: string;
  readonly pointer: string;
}): { readonly aliases: readonly string[] } | NetworkMapping {
  const { source, logical, pointer } = opts;
  if (Array.isArray(source)) {
    return source.length === 1 && source[0] === logical
      ? { aliases: [] }
      : refuse(pointer, "single_owned_bridge_required");
  }
  if (!(isRecord(source) && Object.keys(source).length === 1)) {
    return refuse(pointer, "single_owned_bridge_required");
  }
  const value = source[logical];
  const selected = importPointer(pointer, logical);
  if (!isRecord(value)) {
    return refuse(selected, "owned_bridge_attachment_required");
  }
  const unknown = Object.keys(value).find((key) => key !== "aliases");
  if (unknown) {
    return refuse(
      importPointer(selected, unknown),
      "unsupported_network_attachment"
    );
  }
  if (!Object.hasOwn(value, "aliases")) {
    return { aliases: [] };
  }
  if (!Array.isArray(value.aliases)) {
    return refuse(`${selected}/aliases`, "static_network_aliases_required");
  }
  const seen = new Set<string>();
  for (const [index, alias] of value.aliases.entries()) {
    if (typeof alias !== "string" || !validName(alias) || seen.has(alias)) {
      return refuse(
        `${selected}/aliases/${index}`,
        "static_unique_network_alias_required"
      );
    }
    seen.add(alias);
  }
  return { aliases: [...seen].sort() };
}

function declaredOne(
  source: Record<string, unknown>,
  logical: string
): NetworkMapping | { readonly logical: string; readonly internal: boolean } {
  if (!validName(logical) || logical === "default" || logical === "ingress") {
    return refuse("/networks", "named_owned_bridge_required");
  }
  const pointer = importPointer("/networks", logical);
  const definition = source[logical];
  if (!isRecord(definition)) {
    return refuse(pointer, "owned_bridge_definition_required");
  }
  const unknown = Object.keys(definition).find(
    (key) => key !== "driver" && key !== "internal"
  );
  if (unknown) {
    return refuse(
      importPointer(pointer, unknown),
      "unsupported_network_policy"
    );
  }
  if (Object.hasOwn(definition, "driver") && definition.driver !== "bridge") {
    return refuse(`${pointer}/driver`, "owned_bridge_driver_required");
  }
  if (
    !Object.hasOwn(definition, "internal") ||
    typeof definition.internal !== "boolean"
  ) {
    return refuse(`${pointer}/internal`, "explicit_internal_policy_required");
  }
  return { logical, internal: definition.internal };
}

function declared(
  source: unknown
): NetworkMapping | { readonly logical: string; readonly internal: boolean } {
  if (!(isRecord(source) && Object.keys(source).length === 1)) {
    return refuse("/networks", "single_owned_bridge_required");
  }
  const logical = Object.keys(source)[0];
  return logical
    ? declaredOne(source, logical)
    : refuse("/networks", "named_owned_bridge_required");
}

function attached(
  services: Record<string, unknown>,
  logical: string
):
  | NetworkMapping
  | {
      readonly attachments: LegacyOwnedNetworkIntent["attachments"];
      readonly pointers: Extract<NetworkMapping, { kind: "owned" }>["pointers"];
    } {
  const serviceNames = new Set(Object.keys(services));
  const seenAliases = new Set<string>();
  const attachments: { service: string; aliases: readonly string[] }[] = [];
  const pointers = [
    { source: "/networks", target: "/networks", code: "owned_bridge" },
  ];
  for (const [service, source] of Object.entries(services).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const servicePointer = importPointer("/services", service);
    const selected = `${servicePointer}/networks`;
    if (
      !(
        validName(service) &&
        isRecord(source) &&
        Object.hasOwn(source, "networks")
      )
    ) {
      return refuse(selected, "explicit_owned_bridge_attachment_required");
    }
    const mapped = attachment({
      source: source.networks,
      logical,
      pointer: selected,
    });
    if ("kind" in mapped) {
      return mapped;
    }
    for (const alias of mapped.aliases) {
      if (serviceNames.has(alias) || seenAliases.has(alias)) {
        return refuse(
          `${selected}/${logical}/aliases`,
          "network_alias_collision"
        );
      }
      seenAliases.add(alias);
    }
    attachments.push({ service, aliases: mapped.aliases });
    pointers.push({
      source: selected,
      target: `${servicePointer}/networks`,
      code: "owned_bridge_attachment",
    });
  }
  return { attachments, pointers };
}

function multiple(
  project: string,
  source: Record<string, unknown>,
  services: Record<string, unknown>
): NetworkMapping {
  const names = Object.keys(source).sort();
  if (names.length !== 2) {
    return refuse("/networks", "two_owned_bridges_required");
  }
  const networks: LegacyOwnedNetworksIntent["networks"][number][] = [];
  for (const logical of names) {
    const definition = declaredOne(source, logical);
    if ("kind" in definition) {
      return definition;
    }
    networks.push({
      logical,
      name: `${project}_${logical}`,
      internal: definition.internal,
    });
  }
  const serviceNames = new Set(Object.keys(services));
  const aliasesByNetwork = new Map<string, Set<string>>(
    names.map((name) => [name, new Set<string>()])
  );
  const used = new Set<string>();
  const attachments: LegacyOwnedNetworksIntent["attachments"][number][] = [];
  const pointers = [
    { source: "/networks", target: "/networks", code: "owned_bridges" },
  ];
  for (const [service, declaration] of Object.entries(services).sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    const selected = `${importPointer("/services", service)}/networks`;
    if (
      !(
        validName(service) &&
        isRecord(declaration) &&
        Object.hasOwn(declaration, "networks") &&
        isRecord(declaration.networks)
      )
    ) {
      return refuse(selected, "explicit_owned_bridge_attachments_required");
    }
    const selectedNetworks = Object.keys(declaration.networks).sort();
    if (
      selectedNetworks.length === 0 ||
      selectedNetworks.length > 2 ||
      selectedNetworks.some((name) => !aliasesByNetwork.has(name))
    ) {
      return refuse(selected, "closed_owned_bridge_attachments_required");
    }
    const perService: LegacyOwnedNetworksIntent["attachments"][number]["networks"][number][] =
      [];
    for (const logical of selectedNetworks) {
      const mapped = attachment({
        source: { [logical]: declaration.networks[logical] },
        logical,
        pointer: selected,
      });
      if ("kind" in mapped) {
        return mapped;
      }
      const seen = aliasesByNetwork.get(logical);
      if (!seen) {
        return refuse(selected, "closed_owned_bridge_attachments_required");
      }
      for (const alias of mapped.aliases) {
        if (serviceNames.has(alias) || seen.has(alias)) {
          return refuse(
            `${selected}/${logical}/aliases`,
            "network_alias_collision"
          );
        }
        seen.add(alias);
      }
      used.add(logical);
      perService.push({ logical, aliases: mapped.aliases });
    }
    attachments.push({ service, networks: perService });
    pointers.push({
      source: selected,
      target: selected,
      code: "owned_bridge_attachments",
    });
  }
  if (used.size !== networks.length) {
    return refuse("/networks", "unused_owned_bridge");
  }
  return {
    kind: "multiple",
    intent: { networks, attachments },
    pointers,
  };
}

/** One or two closed project bridges; unknown Compose topology never becomes native authority. */
export function mapLegacyOwnedNetwork(opts: {
  readonly project: string;
  readonly compose: Record<string, unknown>;
}): NetworkMapping {
  const services = opts.compose.services;
  if (!isRecord(services)) {
    return refuse("/services", "services_required");
  }
  if (!Object.hasOwn(opts.compose, "networks")) {
    for (const [service, source] of Object.entries(services)) {
      if (isRecord(source) && Object.hasOwn(source, "networks")) {
        return refuse(
          importPointer(importPointer("/services", service), "networks"),
          "owned_bridge_declaration_required"
        );
      }
    }
    return { kind: "omitted" };
  }
  if (
    isRecord(opts.compose.networks) &&
    Object.keys(opts.compose.networks).length === 2
  ) {
    return multiple(opts.project, opts.compose.networks, services);
  }
  const definition = declared(opts.compose.networks);
  if ("kind" in definition) {
    return definition;
  }
  const { logical, internal } = definition;
  const selection = attached(services, logical);
  if ("kind" in selection) {
    return selection;
  }
  return {
    kind: "owned",
    intent: {
      logical,
      name: `${opts.project}_${logical}`,
      internal,
      attachments: selection.attachments,
    },
    pointers: selection.pointers,
  };
}
