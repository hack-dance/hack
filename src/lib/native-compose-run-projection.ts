import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import {
  createNativeComposeProbe,
  type NativeComposeOwnershipObservation,
} from "./native-compose-ownership.ts";
import { readNativeComposeRouteMetadata } from "./native-compose-route-owner.ts";

const ROUTING = "x-hack-native-routing";
const ROUTE_LABEL = /^(?:caddy(?:\.|$)|caddy_)/;
const ID = /^[a-f0-9]{64}$/;
const FORMAT =
  '{"id":{{json .Id}},"routeLabels":[{{range $key,$value := .Config.Labels}}{{if or (eq $key "caddy") (and (ge (len $key) 6) (eq (slice $key 0 6) "caddy.")) (and (ge (len $key) 6) (eq (slice $key 0 6) "caddy_"))}}{{json $key}},{{end}}{{end}}null]}';
type Document = Readonly<Record<string, unknown>>;

function invalid(): never {
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message: "Native Compose one-off projection is invalid; values omitted.",
  });
}

/** Private JSON only. The generation owner must fence the published file before effects. */
export function projectNativeComposeOneOff(opts: {
  readonly document: Document;
  readonly generationId: string;
  readonly service: string;
}): Document {
  readNativeComposeRouteMetadata({
    generationId: opts.generationId,
    document: opts.document,
  });
  const projected: unknown = structuredClone(opts.document);
  if (!(isRecord(projected) && isRecord(projected.services))) {
    return invalid();
  }
  if (!Object.hasOwn(projected.services, opts.service)) {
    return invalid();
  }
  const service = projected.services[opts.service];
  if (!(isRecord(service) && isRecord(service.labels))) {
    return invalid();
  }
  service.labels = Object.fromEntries(
    Object.entries(service.labels).filter(([key]) => !ROUTE_LABEL.test(key))
  );
  // These proof targets describe the saved graph, not the one-off delivery.
  delete projected[ROUTING];
  freezePrivate(projected);
  return projected;
}

function freezePrivate(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      freezePrivate(child);
    }
    Object.freeze(value);
  }
}

/** Ignore only verified private routing receipts; every rendered workload field must match. */
export function nativeComposeRunSourceMatches(opts: {
  readonly saved: Document;
  readonly rendered: Document;
  readonly generationId: string;
}): boolean {
  readNativeComposeRouteMetadata({
    generationId: opts.generationId,
    document: opts.saved,
  });
  const saved = { ...opts.saved };
  delete saved[ROUTING];
  return JSON.stringify(saved) === JSON.stringify(opts.rendered);
}

/** A no-deps run must leave every retained non-one-off container identity intact. */
export function nativeComposeRunContainerIdentity(
  observed: NativeComposeOwnershipObservation
): string {
  return JSON.stringify(
    observed.containers
      .filter((container) => !container.oneoff)
      .map((container) => [
        container.service,
        container.id,
        container.generationId,
      ])
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
  );
}

/** Verify removed route keys on the actual stopped one-off before deleting its exact owned ID. */
export async function assertNativeComposeOneOffUnexposed(opts: {
  readonly id: string;
  readonly signal?: AbortSignal;
  readonly probe?: ReturnType<typeof createNativeComposeProbe>;
}): Promise<void> {
  try {
    if (!ID.test(opts.id)) {
      return invalid();
    }
    const probe =
      opts.probe ?? createNativeComposeProbe({ signal: opts.signal });
    const value: unknown = JSON.parse(
      await probe(["container", "inspect", "--format", FORMAT, opts.id])
    );
    if (
      !(
        isRecord(value) &&
        Object.keys(value).sort().join() === "id,routeLabels" &&
        value.id === opts.id &&
        Array.isArray(value.routeLabels) &&
        value.routeLabels.length === 1 &&
        value.routeLabels[0] === null
      )
    ) {
      return invalid();
    }
  } catch {
    return invalid();
  }
}
