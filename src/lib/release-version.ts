import { execOrThrow } from "./shell.ts";

/** Execute only a checksum-verified staged CLI and require its documented output. */
export async function verifyStagedReleaseVersion(
  binary: string,
  version: string
): Promise<void> {
  const result = await execOrThrow([binary, "--version"], {
    stdin: "ignore",
    timeoutMs: 10_000,
  });
  if (result.stdout.trim() !== `hack v${version}`) {
    throw new Error(
      "Downloaded CLI version does not match the selected release; installation unchanged."
    );
  }
}
