import type {
  ProjectRemoteAddress,
  SelectedProjectRemote,
} from "./project-remotes-config.ts";

export interface ProjectRemoteStatus {
  readonly service: string;
  readonly kind: "remote";
  readonly target: string;
  readonly defaultTarget?: string;
  readonly address: (ProjectRemoteAddress & { readonly port: number }) | null;
  readonly via: "aws-ssm" | null;
  readonly state: "unknown" | "declared" | "tunnel not started by this version";
  readonly probe: "not checked";
}

/** Render observed targets without resolving env references. */
export function projectRemoteStatuses(
  remotes: readonly SelectedProjectRemote[] = [],
  observed: readonly SelectedProjectRemote[] = []
): readonly ProjectRemoteStatus[] {
  return remotes.map(({ remote }) => {
    const match = observed.find((choice) => choice.remote === remote);
    let state: ProjectRemoteStatus["state"] = "unknown";
    if (match) {
      state = match.via ? "tunnel not started by this version" : "declared";
    }
    return {
      service: remote,
      kind: "remote",
      target: match?.target ?? "unknown",
      address: match ? { ...match.address, port: match.port } : null,
      via: match?.via ?? null,
      state,
      probe: "not checked",
    };
  });
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
