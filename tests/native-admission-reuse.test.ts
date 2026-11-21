import { expect, test } from "bun:test";
import {
  NATIVE_ADMISSION_REUSE_SETTING,
  nativeAdmissionReuseEnvironment,
} from "../src/backends/native-admission-reuse.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

const UP = ["runtime", "up", "--json"];
const NAME = "HACK_NATIVE_ADMISSION_REUSE_SECONDS";

test("the admission reuse bound is named as the runtime names it", () => {
  expect(NATIVE_ADMISSION_REUSE_SETTING).toBe(NAME);
});

test("a bound from 0 to 600 is handed to runtime up as written, 0 included", () => {
  // Leading zeros are the runtime's to read: it accepts up to six digits.
  for (const value of ["0", "1", "60", "599", "600", "000600", "000000"]) {
    expect(nativeAdmissionReuseEnvironment(UP, { [NAME]: value })).toEqual({
      [NAME]: value,
    });
  }
});

test("an unset or empty bound hands over nothing, so the runtime's default applies", () => {
  expect(nativeAdmissionReuseEnvironment(UP, {})).toEqual({});
  expect(nativeAdmissionReuseEnvironment(UP, { [NAME]: undefined })).toEqual(
    {}
  );
  expect(nativeAdmissionReuseEnvironment(UP, { [NAME]: "" })).toEqual({});
});

test("no other runtime command receives the bound, and none is refused for a bad one", () => {
  for (const args of [
    [],
    ["runtime"],
    ["runtime", "status"],
    ["runtime", "down"],
    ["runtime", "check-project-share"],
    ["project", "plan"],
    ["project", "up"],
    ["graph", "up"],
    ["up", "runtime"],
  ]) {
    for (const value of ["60", "0", "601", "soon"]) {
      expect(nativeAdmissionReuseEnvironment(args, { [NAME]: value })).toEqual(
        {}
      );
    }
  }
});

test("anything that is not one to six ASCII digits naming 0 to 600 is refused, never reduced or defaulted", () => {
  for (const value of [
    "-1",
    "+1",
    "601",
    "3600",
    "999999",
    "1000000",
    "0000600",
    "1.5",
    "60s",
    " 60",
    "60 ",
    "60\n",
    "1e2",
    "0x10",
    "on",
    "off",
    // Arabic-Indic and fullwidth digits: digits, but not ASCII ones.
    "٦٠",
    "６０",
  ]) {
    let refusal: unknown;
    try {
      nativeAdmissionReuseEnvironment(UP, { [NAME]: value });
    } catch (error) {
      refusal = error;
    }
    expect(refusal, JSON.stringify(value)).toBeInstanceOf(HackCliError);
    expect(refusal).toMatchObject({
      code: "E_CONFIG_INVALID",
      message: `${NAME} must be a whole number of seconds from 0 to 600; 0 turns reuse off. A larger value is refused, not reduced to 600.`,
    });
  }
});

test("without an environment argument the bound is read from this process", () => {
  const prior = process.env[NAME];
  try {
    process.env[NAME] = "45";
    expect(nativeAdmissionReuseEnvironment(UP)).toEqual({ [NAME]: "45" });
    process.env[NAME] = "601";
    expect(() => nativeAdmissionReuseEnvironment(UP)).toThrow(NAME);
    Reflect.deleteProperty(process.env, NAME);
    expect(nativeAdmissionReuseEnvironment(UP)).toEqual({});
  } finally {
    if (prior === undefined) {
      Reflect.deleteProperty(process.env, NAME);
    } else {
      process.env[NAME] = prior;
    }
  }
});
