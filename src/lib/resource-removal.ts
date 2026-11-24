import { HackCliError } from "./cli-result.ts";
import {
  projectDockerTransportEnvironment,
  readDockerDaemonIdentity,
} from "./docker-helper-environment.ts";
import { verifyResourceDetachment } from "./resource-detachment.ts";
import {
  pruneResourceReceipt,
  readResourceReceipt,
  resourceFingerprint,
} from "./resource-receipts.ts";
import {
  COMPOSE_PROJECT,
  CONTAINER_ID,
  dockerDiskBytes,
  dockerNames,
  dockerResourceReader,
  inspectDockerResource,
} from "./resources-docker.ts";
import { removableKind } from "./resources-inventory.ts";

function refused(reason: string, message: string): never {
  throw new HackCliError({
    code: "E_PLAN_REFUSED",
    message,
    detail: { reason },
  });
}

async function pinnedDocker(cwd: string) {
  const env = projectDockerTransportEnvironment();
  if (!(env.DOCKER_CONTEXT || env.DOCKER_HOST)) {
    const context = await dockerResourceReader({ cwd, env })([
      "context",
      "show",
    ]);
    if (!context || context.includes("\n")) {
      refused(
        "engine_context_unknown",
        "The Docker context could not be pinned."
      );
    }
    env.DOCKER_CONTEXT = context;
  }
  return {
    read: dockerResourceReader({ cwd, env }),
    daemon: async () => {
      const engine = await readDockerDaemonIdentity({ cwd, env });
      return engine.kind === "verified" ? engine.id : null;
    },
  };
}

const STOPPED = new Set(["exited", "dead"]);

export async function planResourceRemoval(opts: {
  readonly id: string;
  readonly cwd: string;
  readonly docker?: Awaited<ReturnType<typeof pinnedDocker>>;
  readonly expectedToken?: string;
}) {
  const [kind, id, extra] = opts.id.split(":");
  if (!(kind && removableKind(kind) && id && extra === undefined)) {
    throw new HackCliError({
      code: "E_USAGE",
      message: "Choose a container:<id> or volume:<name> from resources list.",
    });
  }
  const docker = opts.docker ?? (await pinnedDocker(opts.cwd));
  const { read, daemon } = docker;
  const engine = await daemon();
  if (!engine) {
    refused(
      "engine_unknown",
      "The Docker engine identity could not be verified."
    );
  }
  const [row, receipt] = await Promise.all([
    inspectDockerResource(read, kind, id),
    readResourceReceipt({ daemon: engine, kind, id }),
  ]);
  if (
    !(row && receipt) ||
    resourceFingerprint(kind, row) !== receipt.fingerprint
  ) {
    refused(
      "receipt_mismatch",
      "The current resource does not match a Hack launch receipt on this engine."
    );
  }
  if (
    kind === "container" &&
    !(typeof row.state === "string" && STOPPED.has(row.state))
  ) {
    refused(
      "container_active",
      "The container is running or its stopped state could not be verified."
    );
  }
  const detachment = await verifyResourceDetachment(receipt);
  if (kind === "volume") {
    const references = dockerNames(
      await read(["ps", "-aq", "--no-trunc", "--filter", `volume=${id}`]),
      CONTAINER_ID
    );
    if (references === null) {
      refused(
        "volume_references_unknown",
        "Volume references could not be verified."
      );
    }
    if (references.length > 0) {
      refused("volume_referenced", "A container still references this volume.");
    }
    if (!detachment.detached) {
      refused(detachment.code, detachment.reason);
    }
  }
  if (kind === "container") {
    const states = await read([
      "ps",
      "-a",
      "--filter",
      `label=${COMPOSE_PROJECT}=${receipt.composeProject}`,
      "--format",
      "{{.State}}",
    ]);
    if (!states?.split("\n").every((state) => STOPPED.has(state))) {
      refused(
        "project_not_down",
        "The Compose project has an active container or its stopped state is unverified."
      );
    }
    if (
      !["detached", "registry_reference", "checkout_present"].includes(
        detachment.code
      )
    ) {
      refused(detachment.code, detachment.reason);
    }
  }
  if ((await daemon()) !== engine) {
    refused("engine_changed", "The Docker engine identity changed.");
  }
  const token = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([engine, kind, id, receipt, detachment]))
    .digest("hex");
  if (opts.expectedToken !== undefined && opts.expectedToken !== token) {
    refused(
      "confirmation_stale",
      "The confirmed resource changed. Preview removal again."
    );
  }
  const size =
    kind === "volume" && opts.expectedToken === undefined
      ? await read([
          "system",
          "df",
          "-v",
          "--format",
          "{{json .Volumes}}",
        ]).then((text) => {
          try {
            const list: unknown = JSON.parse(text ?? "null");
            const value = Array.isArray(list)
              ? list.find((entry) => entry?.Name === id)?.Size
              : undefined;
            return dockerDiskBytes(
              typeof value === "string" ? value : undefined
            );
          } catch {
            return null;
          }
        })
      : null;
  const reason = detachment.detached
    ? `${detachment.reason} Hack has not seen this project at any other path.`
    : "Every observed container in this Compose project is stopped.";
  const message = `Delete ${kind} ${id} permanently? This cannot be undone.\nSize: ${size === null ? "unknown" : `${size} bytes`}.\nCheckouts: ${detachment.paths.map((path) => JSON.stringify(path)).join(", ") || "unknown"}.\n${reason}`;
  return {
    kind,
    id,
    token,
    message,
    docker,
    engine,
    read,
    fingerprint: receipt.fingerprint,
    composeProject: receipt.composeProject,
  };
}

export async function removeResource(opts: {
  readonly id: string;
  readonly cwd: string;
  readonly token: string;
  readonly docker: Awaited<ReturnType<typeof pinnedDocker>>;
}) {
  const plan = await planResourceRemoval({
    ...opts,
    expectedToken: opts.token,
  });
  const current = await inspectDockerResource(plan.read, plan.kind, plan.id);
  if (
    !current ||
    resourceFingerprint(plan.kind, current) !== plan.fingerprint
  ) {
    refused("resource_changed", "Resource identity changed before removal.");
  }
  // Hack holds the Compose-name lock. Docker has no compare-and-delete by
  // volume identity. An out-of-band recreation in this last window can lose
  // the replacement volume only if unreferenced. Non-forced removal refuses volumes referenced
  // by any container and refuses active containers.
  if ((await plan.read([plan.kind, "rm", plan.id])) === null) {
    refused(
      "engine_refused",
      "Docker refused removal. The resource may have become active, referenced, or unavailable."
    );
  }
  await pruneResourceReceipt(plan.engine, plan.kind, plan.id).catch(
    () => undefined
  );
}
