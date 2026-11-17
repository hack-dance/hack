import { expect, test } from "bun:test";
import { NativeAuthoredProjectStartError } from "../src/backends/native-authored-project-start.ts";
import {
  environmentNameRefusal,
  isNativeEnvironmentNameError,
  NativeEnvironmentNameError,
  renderNativeEnvironmentNameError,
} from "../src/lib/native-environment-name-error.ts";
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
    'Host command tunnel sets environment variable "BASH_FUNC_x%%", which is not a portable name'
  );
});

test("the compiler's environment-key diagnostic becomes the named refusal; other diagnostics do not", () => {
  const named = environmentNameRefusal([
    { code: "invalid_duration", pointer: "/services/web/stop_grace" },
    {
      code: "invalid_environment_key",
      pointer: "/host/processes/tunnel/environment/FOO~1BAR~0%%",
    },
  ]);
  expect(named?.message).toBe(
    'Project configuration sets environment variable "FOO/BAR~%%" at "/host/processes/tunnel/environment", which is not a portable name (letters, digits and _, not starting with a digit). Rename it in the project configuration. Values omitted.'
  );
  expect(
    environmentNameRefusal([
      {
        code: "invalid_environment_key",
        pointer: "/services/web/environment/TOKEN/env_ref",
      },
      { code: "invalid_environment_key", pointer: "/environment" },
      // A variable named `environment` whose env_ref is invalid.
      {
        code: "invalid_environment_key",
        pointer: "/services/web/environment/environment/env_ref",
      },
    ])
  ).toBeUndefined();
});

test("the refusal is fixed at construction: a changed message, bad parts or a lookalike carry nothing", () => {
  const error = NativeEnvironmentNameError.forHostCommand({
    invocation: "tunnel",
    variable: "FOO%%",
  });
  const sentence = error.message;
  expect(() => {
    (error as { message: string }).message = "private fixture detail";
  }).toThrow();
  expect(error.message).toBe(sentence);
  expect(renderNativeEnvironmentNameError(error)).toBe(sentence);
  // An invocation that is not a contract name is never echoed.
  expect(
    NativeEnvironmentNameError.forHostCommand({
      invocation: "private fixture detail\n",
      variable: "A%",
    }).message
  ).toStartWith('A host command sets environment variable "A%"');
  const lookalike = Object.assign(new Error("private fixture detail"), {
    name: "NativeEnvironmentNameError",
    code: "E_CONFIG_INVALID",
    reason: "environment_name_not_portable",
  });
  expect(isNativeEnvironmentNameError(lookalike)).toBe(false);
  expect(renderNativeEnvironmentNameError(lookalike)).toBeUndefined();
  const forged = Object.create(NativeEnvironmentNameError.prototype);
  expect(forged).toBeInstanceOf(NativeEnvironmentNameError);
  expect(isNativeEnvironmentNameError(forged)).toBe(false);
});

test("startup failure names the refused variable with its own closed code", () => {
  const error = new NativeAuthoredProjectStartError({
    outcome: "not-started",
    canceled: false,
    stage: "selection",
    environmentName: NativeEnvironmentNameError.forHostCommand({
      invocation: "tunnel",
      variable: "FOO%%",
    }),
  });
  expect(error.nativeCode).toBe("environment_name_not_portable");
  expect(error.environmentName?.code).toBe("E_CONFIG_INVALID");
  expect(error.message).toContain(
    'Host command tunnel sets environment variable "FOO%%"'
  );
  expect(error.message).not.toContain("artifact is unsafe");
  const forged = Object.create(NativeEnvironmentNameError.prototype);
  forged.message = "private fixture detail";
  for (const environmentName of [
    forged,
    Object.assign(new Error("private fixture detail"), {
      name: "NativeEnvironmentNameError",
    }),
  ]) {
    const plain = new NativeAuthoredProjectStartError({
      outcome: "not-started",
      canceled: false,
      environmentName,
    });
    expect(plain.nativeCode).toBeUndefined();
    expect(plain.environmentName).toBeUndefined();
    expect(plain.message).not.toContain("private fixture detail");
  }
});
