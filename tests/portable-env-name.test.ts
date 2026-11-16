import { expect, test } from "bun:test";
import { NativeAuthoredProjectStartError } from "../src/backends/native-authored-project-start.ts";
import { NativeHostEnvironmentNameError } from "../src/lib/native-compose-host-contract.ts";
import { selectNativeHostLifecycle } from "../src/lib/native-host-lifecycle-contract.ts";
import {
  displayEnvName,
  isPortableEnvName,
  nonPortableEnvNames,
  portableInheritedEnvironment,
} from "../src/lib/portable-env-name.ts";

// HACK-2219: bash exports a function f as BASH_FUNC_f%%, and `env 'FOO%%=1'`
// is legal. Such inherited names are dropped by native launches, never fatal.

const inherited = {
  PATH: "/usr/bin",
  _private: "kept",
  "BASH_FUNC_hack2219%%": "() {  echo fixture\n}",
  "FOO%%": "1",
  "1LEADING_DIGIT": "1",
  "": "empty",
  UNSET: undefined,
};

test("only portable inherited names are kept", () => {
  expect(portableInheritedEnvironment(inherited)).toEqual({
    PATH: "/usr/bin",
    _private: "kept",
  });
  expect(nonPortableEnvNames(inherited).sort()).toEqual(
    ["", "1LEADING_DIGIT", "BASH_FUNC_hack2219%%", "FOO%%"].sort()
  );
  expect(isPortableEnvName("A_1")).toBe(true);
  expect(isPortableEnvName("A-1")).toBe(false);
});

test("names are shown escaped and bounded, never raw control or bidi text", () => {
  expect(displayEnvName("FOO%%")).toBe('"FOO%%"');
  expect(displayEnvName('A"\\\u001b‮')).toBe(
    '"A\\u{22}\\u{5c}\\u{1b}\\u{202e}"'
  );
  expect(displayEnvName("x".repeat(200))).toBe(`"${"x".repeat(128)}…"`);
});

test("an authored host process name that is not portable is refused by name before any effect", () => {
  expect(() =>
    selectNativeHostLifecycle({
      host: {
        processes: {
          tunnel: {
            command: { exec: ["/bin/true"] },
            cwd: ".",
            env_target: { kind: "host" },
            environment: { "BASH_FUNC_x%%": { literal: "fixture-value" } },
          },
        },
      },
    })
  ).toThrow(
    new NativeHostEnvironmentNameError({
      invocation: "tunnel",
      variable: "BASH_FUNC_x%%",
    }).message
  );
});

test("startup failure names the refused variable with its own closed code", () => {
  const error = new NativeAuthoredProjectStartError({
    outcome: "not-started",
    canceled: false,
    stage: "selection",
    hostEnvironmentName: new NativeHostEnvironmentNameError({
      invocation: "tunnel",
      variable: "FOO%%",
    }),
  });
  expect(error.nativeCode).toBe("host_environment_name_not_portable");
  expect(error.message).toContain(
    'Host command tunnel sets environment variable "FOO%%"'
  );
  expect(error.message).not.toContain("artifact is unsafe");
  // Anything that is not the closed error adds nothing to the message.
  const lookalike = new Error("private fixture detail");
  lookalike.name = "NativeHostEnvironmentNameError";
  const plain = new NativeAuthoredProjectStartError({
    outcome: "not-started",
    canceled: false,
    hostEnvironmentName: lookalike,
  });
  expect(plain.nativeCode).toBeUndefined();
  expect(plain.message).not.toContain("private fixture detail");
});
