import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { isRecord } from "./guards.ts";
import type { NativeComposeIdentity } from "./native-compose-generation.ts";
import {
  keys,
  NativeComposeGenerationError,
} from "./native-compose-private-state.ts";

const PROFILE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
function refuse(): never {
  throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
}

export type NativeComposeSavedNetworkTopology = {
  readonly networks: readonly {
    readonly name: string;
    readonly driver: "bridge";
    readonly internal: boolean;
  }[];
  readonly workloads: readonly {
    readonly service: string;
    readonly networks: readonly {
      readonly logicalName: string;
      readonly name: string;
      readonly aliases: readonly string[];
      readonly external: boolean;
    }[];
  }[];
};

type SavedNetworkDefinition = {
  readonly name: string;
  readonly driver: "bridge";
  readonly internal: boolean;
  readonly external: boolean;
};

function savedNetworkDefinition(
  logicalName: string,
  value: unknown,
  identity: Pick<NativeComposeIdentity, "composeProject" | "ownerToken">
): SavedNetworkDefinition {
  if (!isRecord(value)) {
    return refuse();
  }
  if (logicalName === "ingress") {
    if (
      !(
        keys(value, "external,name") &&
        value.external === true &&
        value.name === DEFAULT_INGRESS_NETWORK
      )
    ) {
      return refuse();
    }
    return {
      name: DEFAULT_INGRESS_NETWORK,
      driver: "bridge",
      internal: false,
      external: true,
    };
  }
  const legacy =
    logicalName === "default" &&
    (keys(value, "labels,name") || keys(value, "labels"));
  const physicalName =
    logicalName === "default"
      ? `${identity.composeProject}_default`
      : `hack-net-${identity.composeProject.length}-${identity.composeProject}-${logicalName.length}-${logicalName}`;
  if (
    !(
      PROFILE.test(logicalName) &&
      (legacy || keys(value, "driver,internal,labels,name")) &&
      (value.name === physicalName || (legacy && value.name === undefined)) &&
      (legacy ||
        (value.driver === "bridge" && typeof value.internal === "boolean")) &&
      (logicalName !== "default" || legacy || value.internal === false) &&
      isRecord(value.labels) &&
      value.labels["io.hack.native-config.version"] === "1" &&
      value.labels["io.hack.native-config.instance"] ===
        identity.composeProject &&
      value.labels["io.hack.native-config.owner"] === identity.ownerToken
    )
  ) {
    return refuse();
  }
  return {
    name: physicalName,
    driver: "bridge",
    internal: legacy ? false : (value.internal as boolean),
    external: false,
  };
}

/** The saved document is authoritative for topology; authored inputs are never reparsed. */
export function readNativeComposeNetworkTopology(
  document: unknown,
  identity: Pick<NativeComposeIdentity, "composeProject" | "ownerToken">
): NativeComposeSavedNetworkTopology {
  if (!(isRecord(document) && isRecord(document.services))) {
    return refuse();
  }
  const definitions = new Map<string, SavedNetworkDefinition>();
  const supplied = Object.hasOwn(document, "networks") ? document.networks : {};
  if (!isRecord(supplied)) {
    return refuse();
  }
  for (const [logicalName, value] of Object.entries(supplied)) {
    definitions.set(
      logicalName,
      savedNetworkDefinition(logicalName, value, identity)
    );
  }
  // Pre-topology version-one documents may omit the explicit default definition.
  if (!(definitions.has("default") || Object.hasOwn(document, "networks"))) {
    definitions.set("default", {
      name: `${identity.composeProject}_default`,
      driver: "bridge",
      internal: false,
      external: false,
    });
  }
  const used = new Set<string>();
  const services = new Set(Object.keys(document.services));
  const claimedAliases = new Set<string>();
  const workloads = Object.entries(document.services).map(
    ([service, value]) => {
      if (!(PROFILE.test(service) && isRecord(value))) {
        return refuse();
      }
      const attachments = value.networks;
      let selections: [string, unknown][];
      if (attachments === undefined) {
        selections = [["default", {}]];
      } else if (Array.isArray(attachments)) {
        if (
          !(
            attachments.length > 0 &&
            attachments.every(
              (name) => name === "default" || name === "ingress"
            ) &&
            new Set(attachments).size === attachments.length
          )
        ) {
          return refuse();
        }
        selections = attachments.map((name: string) => [name, {}]);
      } else if (isRecord(attachments) && Object.keys(attachments).length > 0) {
        selections = Object.entries(attachments);
      } else {
        return refuse();
      }
      const networks = selections.map(([logicalName, attachment]) => {
        const definition = definitions.get(logicalName);
        if (
          !(
            definition &&
            isRecord(attachment) &&
            (keys(attachment, "") || keys(attachment, "aliases"))
          )
        ) {
          return refuse();
        }
        const aliases = Object.hasOwn(attachment, "aliases")
          ? attachment.aliases
          : [];
        if (
          !(
            Array.isArray(aliases) &&
            aliases.every(
              (alias) => typeof alias === "string" && PROFILE.test(alias)
            ) &&
            new Set(aliases).size === aliases.length &&
            (logicalName !== "ingress" || aliases.length === 0)
          )
        ) {
          return refuse();
        }
        for (const alias of aliases) {
          const key = `${definition.name}\0${alias}`;
          if (services.has(alias) || claimedAliases.has(key)) {
            return refuse();
          }
          claimedAliases.add(key);
        }
        used.add(logicalName);
        return {
          logicalName,
          name: definition.name,
          aliases: [...aliases].sort(),
          external: definition.external,
        };
      });
      return {
        service,
        networks: networks.sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
  );
  if ([...definitions.keys()].some((name) => !used.has(name))) {
    return refuse();
  }
  return {
    networks: [...definitions.values()]
      .filter((network) => !network.external)
      .map(({ name, driver, internal }) => ({ name, driver, internal }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    workloads: workloads.sort((a, b) => a.service.localeCompare(b.service)),
  };
}
