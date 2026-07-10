export type ExecutableCapability =
  | { readonly kind: "available" }
  | { readonly kind: "skip" | "fail"; readonly reason: string };

/** Resolve whether an executable-backed scenario may run, skip locally, or must fail. */
export function resolveExecutableCapability(opts: {
  readonly executable: string;
  readonly executablePath: string | null;
  readonly required: boolean;
  readonly installHint: string;
}): ExecutableCapability {
  if (opts.executablePath) {
    return { kind: "available" };
  }

  const reason = `${opts.executable} unavailable (${opts.installHint})`;
  return opts.required ? { kind: "fail", reason } : { kind: "skip", reason };
}
