/**
 * Portable environment variable names (POSIX: letters, digits and `_`, not
 * starting with a digit).
 *
 * A process can inherit other names. Bash exports a function `f` (`export -f
 * f`) as a variable named `BASH_FUNC_f%%`, and `env 'A%%=1' cmd` is legal.
 * Hack's native lifecycle launches carry an explicit, identifier-checked
 * environment, so they never forward such a name; meeting one in the inherited
 * environment is not an error (HACK-2219). A name the project's own
 * configuration sets is different: the compiler and the host contract refuse
 * it by name.
 */
export const PORTABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isPortableEnvName(name: string): boolean {
  return PORTABLE_ENV_NAME.test(name);
}

/** The inherited string variables whose names are portable. */
export function portableInheritedEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && isPortableEnvName(name)) {
      result[name] = value;
    }
  }
  return result;
}

/** Inherited names a native lifecycle launch drops. */
export function nonPortableEnvNames(
  env: Readonly<Record<string, string | undefined>> = process.env
): string[] {
  return Object.keys(env).filter((name) => !isPortableEnvName(name));
}

/**
 * A variable name for a message. Names are not secret, but they are arbitrary
 * bytes: anything outside printable ASCII is escaped and the result is bounded.
 */
export function displayEnvName(name: string): string {
  let shown = "";
  for (const char of name.slice(0, 128)) {
    const code = char.codePointAt(0) ?? 0;
    shown +=
      code >= 0x20 && code <= 0x7e && char !== '"' && char !== "\\"
        ? char
        : `\\u{${code.toString(16)}}`;
  }
  return `"${shown}${name.length > 128 ? "…" : ""}"`;
}
