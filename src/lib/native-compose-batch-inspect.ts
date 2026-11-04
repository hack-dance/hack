import { isRecord } from "./guards.ts";

const ID = /^[a-f0-9]{64}$/;

function refuse(): never {
  throw new Error("Container inspection membership refused; values omitted.");
}

/** One fresh bounded acquisition per batch. Every selected immutable ID must
 * appear exactly once; transport order grants no identity authority. The caller
 * retains its existing phase fences and validates each projected policy field. */
export async function inspectNativeComposeContainers<
  T extends { readonly id: string },
>(opts: {
  readonly resources: readonly T[];
  readonly format: string;
  readonly probe: (args: readonly string[]) => Promise<string>;
  readonly refuse?: () => never;
}): Promise<{ readonly resource: T; readonly row: Record<string, unknown> }[]> {
  const refuseMembership: () => never = opts.refuse ?? refuse;
  if (
    opts.resources.some((resource) => !ID.test(resource.id)) ||
    new Set(opts.resources.map((resource) => resource.id)).size !==
      opts.resources.length
  ) {
    refuseMembership();
  }
  const result: { resource: T; row: Record<string, unknown> }[] = [];
  for (let offset = 0; offset < opts.resources.length; offset += 64) {
    const batch = opts.resources.slice(offset, offset + 64);
    const text = await opts.probe([
      "container",
      "inspect",
      "--format",
      opts.format,
      ...batch.map((resource) => resource.id),
    ]);
    const lines = text.trim().split("\n");
    if (lines.length !== batch.length) {
      refuseMembership();
    }
    const remaining = new Set(batch.map((resource) => resource.id));
    const rows = new Map<string, Record<string, unknown>>();
    for (const line of lines) {
      const row: unknown = JSON.parse(line);
      if (
        !isRecord(row) ||
        typeof row.id !== "string" ||
        !remaining.delete(row.id)
      ) {
        refuseMembership();
      }
      rows.set(row.id, row);
    }
    for (const resource of batch) {
      const row = rows.get(resource.id);
      if (!row) {
        refuseMembership();
      }
      result.push({ resource, row });
    }
  }
  return result;
}
