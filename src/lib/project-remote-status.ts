import type {
  ProjectRemoteAddress,
  SelectedProjectRemote,
} from "./project-remotes-config.ts";

export interface ProjectRemoteStatus {
  readonly service: string;
  readonly kind: "remote";
  readonly target: string;
  readonly address: (ProjectRemoteAddress & { readonly port: number }) | null;
  readonly via: "aws-ssm" | null;
  readonly state: "unknown" | "declared" | "tunnel not started by this version";
  readonly probe: "not checked";
}

/** Status takes authored descriptors only and never resolves an env reference. */
export function projectRemoteStatuses(
  remotes: readonly SelectedProjectRemote[] | undefined
): readonly ProjectRemoteStatus[] {
  return (remotes ?? []).map(({ remote, target, address, port, via }) => ({
    service: remote,
    kind: "remote",
    target,
    address: { ...address, port },
    via: via ?? null,
    state: via ? "tunnel not started by this version" : "declared",
    probe: "not checked",
  }));
}

export function formatProjectRemoteAddress(
  address: ProjectRemoteStatus["address"]
): string {
  if (!address) {
    return "unknown";
  }
  switch (address.kind) {
    case "service":
      return `${address.service}:${address.port}`;
    case "env_ref":
      return `$${address.name}:${address.port}`;
    case "hostname": {
      const host = address.hostname.includes(":")
        ? `[${address.hostname}]`
        : address.hostname;
      return `${host}:${address.port}`;
    }
    default:
      return address satisfies never;
  }
}
