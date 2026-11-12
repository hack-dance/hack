/**
 * The environment for every helper process Hack vets before trusting its
 * effect or output (the system `sudo`, and in the trust flow the Docker
 * witness and `certutil`).
 *
 * It is an allowlist, not a denylist: the child gets a fixed system `PATH`,
 * the `C` locale and only the identity and terminal variables below. Every
 * other inherited variable is removed, so loader (`LD_PRELOAD`,
 * `LD_LIBRARY_PATH`, `LD_AUDIT`), locale-path (`LOCPATH`, `GCONV_PATH`,
 * `NLSPATH`), interpreter (`BASH_ENV`, `ENV`, `PYTHONPATH`, `NODE_OPTIONS`,
 * `PERL5LIB`, `RUBYOPT`), temp-dir and tool-selection variables cannot reach
 * the helper, including ones added to this list's threat model later.
 */
export const VETTED_HELPER_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

/** Reapply the fixed environment after sudo can replace PATH via secure_path. */
export function vettedRootCommand(argv: readonly string[]): readonly string[] {
  return [
    "/usr/bin/env",
    "-i",
    `PATH=${VETTED_HELPER_PATH}`,
    "LANG=C",
    "LC_ALL=C",
    ...argv,
  ];
}

/** Inherited only when present; none of these selects code or files. */
const PASSED_THROUGH = ["HOME", "USER", "LOGNAME", "TERM"] as const;

export type VettedHelperEnv = {
  /** The complete child environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Every other key of `source`, for APIs that start from `process.env`. */
  readonly unsetEnvKeys: readonly string[];
};

export function vettedHelperEnv(opts?: {
  readonly source?: Readonly<Record<string, string | undefined>>;
  /** Fixed values a caller adds (for example `DOCKER_HOST`). */
  readonly extra?: Readonly<Record<string, string>>;
}): VettedHelperEnv {
  const source = opts?.source ?? process.env;
  const env: Record<string, string> = {
    PATH: VETTED_HELPER_PATH,
    LANG: "C",
    LC_ALL: "C",
  };
  for (const key of PASSED_THROUGH) {
    const value = source[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  Object.assign(env, opts?.extra ?? {});
  return {
    env,
    unsetEnvKeys: Object.keys(source).filter((key) => !(key in env)),
  };
}
