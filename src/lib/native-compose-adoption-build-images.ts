import { isRecord } from "./guards.ts";
import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";
import { freezeImportValue } from "./native-config-import-plan.ts";

const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,511}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const CONTAINER =
  '{"id":{{json .Id}},"image":{{json .Image}},"reference":{{json .Config.Image}},"createdAt":{{json .Created}}}';
const BUILT_IMAGE = '{"id":{{json .Id}},"createdAt":{{json .Created}}}';

/** Private observation of the current image; it does not attest historical build inputs. */
export type LegacyComposeRetainedBuildImage = {
  readonly service: string;
  readonly container: string;
  readonly containerCreatedAt: string;
  readonly reference: string;
  readonly image: string;
  readonly imageCreatedAt: string;
};
function refuse(): never {
  throw new Error(
    "Legacy retained build image identity is unavailable or changed; values omitted."
  );
}
function time(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIME.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function record(text: string, expected: string) {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || Object.keys(value).sort().join() !== expected) {
    refuse();
  }
  return value;
}

/**
 * Uses the authoritative selected Compose image reference, not a guessed name.
 * Reads only IDs, reference and creation time; never image/container environment,
 * command or layer contents. Same daemon and exact original IDs are rechecked.
 * No tag mutation, allocation, build, pull or image removal is authorized.
 */
export async function inspectLegacyComposeRetainedBuildImages(opts: {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly composeFile: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<readonly LegacyComposeRetainedBuildImage[]> {
  try {
    const { composeFile, signal, timeoutMs } = opts;
    const { binding_version, composeProject, projectRoot, engineId } =
      opts.binding;
    const originals = opts.binding.containers.map(({ id, service }) => ({
      id,
      service,
    }));
    if (binding_version !== 1 || !NAME.test(composeProject)) {
      refuse();
    }
    const probe = createNativeComposeProbe({ signal, timeoutMs });
    const engine = async () =>
      (await probe(["info", "--format", "{{json .ID}}"])).trim();
    const baselineEngine = await engine();
    if (JSON.parse(baselineEngine) !== engineId) {
      refuse();
    }
    const result: LegacyComposeRetainedBuildImage[] = [];
    for (const container of originals) {
      if (!ID.test(container.id) || !NAME.test(container.service)) {
        refuse();
      }
      const imageOutput = await probe([
        "compose",
        "--project-name",
        composeProject,
        "--project-directory",
        `${projectRoot}/.hack`,
        "--env-file",
        "/dev/null",
        "--profile",
        "*",
        "--file",
        composeFile,
        "config",
        "--no-env-resolution",
        "--images",
        container.service,
      ]);
      const reference = imageOutput.trim();
      if (!REFERENCE.test(reference)) {
        refuse();
      }
      const original = record(
        await probe([
          "container",
          "inspect",
          "--format",
          CONTAINER,
          container.id,
        ]),
        "createdAt,id,image,reference"
      );
      if (
        original.id !== container.id ||
        original.reference !== reference ||
        typeof original.image !== "string" ||
        !IMAGE.test(original.image) ||
        !time(original.createdAt)
      ) {
        refuse();
      }
      const tagged = record(
        await probe(["image", "inspect", "--format", BUILT_IMAGE, reference]),
        "createdAt,id"
      );
      const exact = record(
        await probe([
          "image",
          "inspect",
          "--format",
          BUILT_IMAGE,
          original.image,
        ]),
        "createdAt,id"
      );
      if (
        tagged.id !== original.image ||
        JSON.stringify(tagged) !== JSON.stringify(exact) ||
        !time(exact.createdAt)
      ) {
        refuse();
      }
      result.push({
        service: container.service,
        container: container.id,
        containerCreatedAt: original.createdAt,
        reference,
        image: original.image,
        imageCreatedAt: exact.createdAt,
      });
    }
    if ((await engine()) !== baselineEngine) {
      refuse();
    }
    freezeImportValue(result);
    return result;
  } catch {
    refuse();
  }
}
