import type { NativeManagedFile } from "./native-project-input.ts";

/** The runtime's complete stdin limit (`provider/managed_environment.rs`). */
export const MAX_NATIVE_PRIVATE_INPUT_BYTES = 256 * 1024;

/**
 * Encode the private stdin envelope; never log it or write it to disk.
 * Validated plan/run IDs are fixed-width hex. Admission may substitute equal-width
 * IDs to measure these exact wire bytes before a replacement run is allocated.
 */
export function nativePrivateEnvironmentPayload(opts: {
  readonly services: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly files?: Readonly<Record<string, readonly NativeManagedFile[]>>;
  readonly planId: string;
  readonly run: string;
}): Buffer {
  const files = Object.entries(opts.files ?? {}).filter(
    ([, members]) => members.length > 0
  );
  return Buffer.from(
    JSON.stringify({
      version: files.length > 0 ? 2 : 1,
      plan: opts.planId,
      run: opts.run,
      lifetime_seconds: 300,
      services: opts.services,
      ...(files.length > 0
        ? {
            files: Object.fromEntries(
              files.map(([service, members]) => [
                service,
                members.map((member) => ({
                  name: member.name,
                  target: member.target,
                  mode: "0400",
                  content_b64: member.content.toString("base64"),
                })),
              ])
            ),
          }
        : {}),
    })
  );
}
