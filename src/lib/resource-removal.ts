import { HackCliError } from "./cli-result.ts";
import {
  readResourceReceipt,
  resourceFingerprint,
} from "./resource-receipts.ts";
import {
  CONTAINER_ID,
  dockerNames,
  inspectDockerResource,
  RESOURCE_NAME,
} from "./resources-docker.ts";
import {
  checkoutGone,
  removableKind,
  resourceDocker,
} from "./resources-inventory.ts";

function refused(message: string): never {
  throw new HackCliError({ code: "E_PLAN_REFUSED", message });
}

export async function planResourceRemoval(opts: {
  readonly id: string;
  readonly cwd: string;
}) {
  const [kind, id, extra] = opts.id.split(":");
  if (!(kind && removableKind(kind) && id && extra === undefined)) {
    throw new HackCliError({
      code: "E_USAGE",
      message: "Choose a container:<id> or volume:<name> from resources list.",
    });
  }
  const { read, daemon } = resourceDocker(opts.cwd);
  const engine = await daemon();
  if (!engine) {
    refused("The Docker engine identity could not be verified.");
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
      "The current resource does not match a Hack launch receipt on this engine."
    );
  }
  if (
    kind === "container" &&
    !["created", "exited", "dead"].some((state) => state === row.state)
  ) {
    refused(
      "The container is running or its stopped state could not be verified."
    );
  }
  if (kind === "volume") {
    const references = dockerNames(
      await read(["ps", "-aq", "--no-trunc", "--filter", `volume=${id}`]),
      CONTAINER_ID
    );
    if (references === null || references.length > 0) {
      refused(
        "A container still references this volume, or the references could not be verified."
      );
    }
    if (!(await checkoutGone(receipt.checkout))) {
      refused("The owning checkout can still reference this volume.");
    }
  }
  if (
    !(kind === "container" ? CONTAINER_ID : RESOURCE_NAME).test(id) ||
    (await daemon()) !== engine
  ) {
    refused("The Docker engine or resource identity changed.");
  }
  const token = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([engine, kind, id, receipt]))
    .digest("hex");
  const message = `Delete ${kind} ${id} from ${JSON.stringify(receipt.project)} permanently? This cannot be undone.`;
  return {
    kind,
    id,
    token,
    message,
    read,
    composeProject: receipt.composeProject,
  };
}

export async function removeResource(opts: {
  readonly id: string;
  readonly cwd: string;
  readonly token: string;
}) {
  const plan = await planResourceRemoval(opts);
  if (plan.token !== opts.token) {
    refused("The confirmed resource changed. Preview removal again.");
  }
  // Docker's non-forced removal rechecks running containers and volume references.
  if ((await plan.read([plan.kind, "rm", plan.id])) === null) {
    refused(
      "Docker refused removal. The resource may have become active, referenced, or unavailable."
    );
  }
}
