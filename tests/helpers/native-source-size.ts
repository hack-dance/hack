const MIB = 1024 * 1024;

/**
 * A synthetic `project source-size` runtime receipt. The default is a small project
 * within the default 128 MiB limit; pass `totalBytes` over the limit for a refusal.
 */
export function nativeSourceSizeReceipt(
  opts: {
    readonly totalBytes?: number;
    readonly limitMiB?: number;
    readonly limitOrigin?: "default" | "project";
  } = {}
): Record<string, unknown> {
  const total = opts.totalBytes ?? 4096;
  const limit = (opts.limitMiB ?? 128) * MIB;
  const large = total > limit;
  return {
    schema_version: 1,
    kind: "native_source_size",
    total_bytes: total,
    file_count: 3,
    limit_bytes: limit,
    limit_origin: opts.limitOrigin ?? "default",
    maximum_limit_bytes: 512 * MIB,
    within_limit: !large,
    largest_files: large
      ? [{ path: "assets/video/intro.bin", bytes: total - 2048 }]
      : [{ path: "src/app.ts", bytes: 2048 }],
    largest_directories: large
      ? [
          { path: "assets", bytes: total - 1024 },
          { path: "assets/video", bytes: total - 2048 },
        ]
      : [{ path: "src", bytes: 2048 }],
  };
}
