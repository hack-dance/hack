import { expect, test } from "bun:test";
import { VETTED_HELPER_PATH, vettedHelperEnv } from "../src/lib/vetted-env.ts";

/** Variables that select code, libraries, locale data or tools. */
const INJECTION = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG_OUTPUT",
  "GCONV_PATH",
  "LOCPATH",
  "NLSPATH",
  "LANGUAGE",
  "LC_CTYPE",
  "BASH_ENV",
  "ENV",
  "IFS",
  "SHELLOPTS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "NODE_OPTIONS",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "RUBYLIB",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "SSL_CERT_FILE",
  "NSS_DEFAULT_DB_TYPE",
  "SUDO_ASKPASS",
];

test("only the allowlist reaches a vetted helper", () => {
  const source = Object.fromEntries([
    ...INJECTION.map((key) => [key, "/home/user/evil"]),
    ["PATH", "/home/user/bin:/usr/bin"],
    ["HOME", "/home/user"],
    ["TERM", "xterm"],
  ]);
  const { env, unsetEnvKeys } = vettedHelperEnv({ source });
  expect(env).toEqual({
    PATH: VETTED_HELPER_PATH,
    LANG: "C",
    LC_ALL: "C",
    HOME: "/home/user",
    TERM: "xterm",
  });
  for (const key of INJECTION) {
    expect(unsetEnvKeys).toContain(key);
  }
  // Applying it the way exec does (inherit, unset, override) leaves nothing else.
  const effective = Object.fromEntries(
    Object.entries(source).filter(([key]) => !unsetEnvKeys.includes(key))
  );
  expect({ ...effective, ...env }).toEqual(env);
});

test("fixed extras are added, and cannot be overridden from the source", () => {
  const { env } = vettedHelperEnv({
    source: { DOCKER_HOST: "tcp://attacker:2375" },
    extra: { DOCKER_HOST: "unix:///var/run/docker.sock" },
  });
  expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
});
