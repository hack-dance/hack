import { expect, test } from "bun:test";
import { nativeBuilderMissingRefusal } from "../src/backends/native-project-builds.ts";
import {
  nativeSetupBuilderNotice,
  nativeSetupGuidance,
} from "../src/backends/native-runtime-setup.ts";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import {
  type CandidateLauncher,
  homeRelativeLauncherCommand,
} from "../src/lib/candidate-launcher.ts";
import { nativeBuilderCheckResult } from "../src/lib/doctor-native-builder.ts";
import {
  nativeBuilderChangedRemedy,
  nativeBuilderMissingDetachedRefusal,
  nativeBuilderRemedy,
  nativeBuilderSetupCommand,
} from "../src/lib/native-image-builder.ts";

/**
 * Every message about the image builder names one setup command: runnable as
 * pasted, and without the user's home directory. The four messages are the
 * `hack up` refusal, the `hack native setup` hint, its changed-builder
 * warning, and doctor's check message with its JSON `detail`.
 */

const HOME = "/home-fixture";
const PATHS = {
  directory: ".hack-local/providers/builder-1.0.0",
  record: ".hack-local/providers/builder.json",
};
const stable = { kind: "stable", command: "hack" } as const;
/** A managed candidate install: its launcher is not on PATH and lives under the home. */
const managed = {
  kind: "hack-next",
  command: `${HOME}/.hack-next/bin/hack-next`,
  bundle: `${HOME}/.hack-next/versions/5.0.0-next.1/bundle/hack-v5`,
} as const;

/** The four messages, and doctor's JSON, for one launcher and home. */
function messages(launcher: CandidateLauncher, homeDir: string) {
  const who = { launcher, homeDir };
  const doctor = (["not_prepared", "changed"] as const).map((builder) =>
    nativeBuilderCheckResult({
      buildServices: 2,
      builder,
      paths: PATHS,
      ...who,
    })
  );
  return {
    refusal: nativeBuilderMissingRefusal({ services: ["web"], ...who }),
    hint: nativeSetupBuilderNotice({ outcome: "not_prepared", ...who })?.text,
    warning: nativeSetupBuilderNotice({
      outcome: "changed",
      paths: PATHS,
      ...who,
    })?.text,
    doctorMissing: doctor[0]?.message,
    doctorChanged: doctor[1]?.message,
    doctorJson: JSON.stringify(
      buildDoctorJsonData({
        results: doctor.map((check) => ({ ...check, durationMs: 1 })),
      })
    ),
  };
}

test("a launcher under the home is printed home-relative in every builder message", () => {
  const command = "~/.hack-next/bin/hack-next native setup --accept-downloads";
  expect(nativeBuilderSetupCommand({ launcher: managed, homeDir: HOME })).toBe(
    command
  );
  const all = messages(managed, HOME);
  expect(all.refusal).toBe(
    `Native foreground up cannot build service web: the image builder is not installed in this native home. Run ${command} to add it; offline, add --builder <pinned builder file> to the offline setup inputs. No image was built.`
  );
  expect(all.hint).toBe(
    `The image builder is not installed, so native up cannot build images yet. Run ${command} to add it; offline, add --builder <pinned builder file> to the offline setup inputs.\n`
  );
  expect(all.warning).toBe(
    `WARN: Setup found that the image builder in this native home does not match the pinned release, so image builds are refused until it is replaced. Setup left it as it is. Remove .hack-local/providers/builder-1.0.0 and .hack-local/providers/builder.json from the native home, then run ${command}.\n`
  );
  expect(all.doctorMissing).toBe(
    `2 services build an image, but the image builder is not installed in this native home, so native up cannot build them. Run ${command} to add it; offline, add --builder <pinned builder file> to the offline setup inputs.`
  );
  expect(all.doctorChanged).toBe(
    `2 services build an image, but the image builder in this native home does not match the pinned release, so native up refuses to build with it. Remove .hack-local/providers/builder-1.0.0 and .hack-local/providers/builder.json from the native home, then run ${command}.`
  );
  // None of them, and nothing in doctor's JSON, carries the home directory.
  for (const text of Object.values(all)) {
    expect(text).toContain(command);
    expect(text).not.toContain(HOME);
  }
  // A home given with a trailing slash is the same home.
  expect(
    nativeBuilderSetupCommand({ launcher: managed, homeDir: `${HOME}/` })
  ).toBe(command);
});

test("the stable launcher on PATH is printed as hack", () => {
  const all = messages(stable, HOME);
  for (const text of Object.values(all)) {
    expect(text).toContain("hack native setup --accept-downloads");
    expect(text).not.toContain("~");
    expect(text).not.toContain(HOME);
  }
  expect(nativeBuilderRemedy({ launcher: stable, homeDir: HOME })).toBe(
    "Run hack native setup --accept-downloads to add it; offline, add --builder <pinned builder file> to the offline setup inputs."
  );
});

test("a launcher outside the home keeps its path", () => {
  const bundle = { kind: "bundle", command: "/opt/bundle/hack-v5" } as const;
  const all = messages(bundle, HOME);
  for (const text of Object.values(all)) {
    expect(text).toContain(
      "/opt/bundle/hack-v5 native setup --accept-downloads"
    );
    expect(text).not.toContain("~");
  }
  // A directory that only starts with the home's name is not under the home.
  expect(
    nativeBuilderSetupCommand({
      launcher: { kind: "bundle", command: `${HOME}-other/bin/hack-v5` },
      homeDir: HOME,
    })
  ).toBe(`${HOME}-other/bin/hack-v5 native setup --accept-downloads`);
});

test("a launcher path that needs quoting keeps the quoted absolute form", () => {
  // A tilde does not expand inside quotes, and a path with a space must be
  // quoted, so `~/...` would not run here. The existing quoted rendering is
  // the command that works.
  const spaced = {
    kind: "bundle",
    command: `${HOME}/my bundles/hack-v5`,
  } as const;
  const command = `'${HOME}/my bundles/hack-v5' native setup --accept-downloads`;
  expect(nativeBuilderSetupCommand({ launcher: spaced, homeDir: HOME })).toBe(
    command
  );
  for (const text of Object.values(messages(spaced, HOME))) {
    // JSON escapes nothing in this command, so the same text is in doctor's JSON.
    expect(text).toContain(command);
    expect(text).not.toContain("~/");
  }
  // Other characters a shell would act on, and paths that leave the home.
  for (const rest of ["a$b/hack-v5", "a'b/hack-v5", "../elsewhere/hack-v5"]) {
    const launcher = { kind: "bundle", command: `${HOME}/${rest}` } as const;
    expect(
      nativeBuilderSetupCommand({ launcher, homeDir: HOME })
    ).not.toStartWith("~");
  }
});

test("without a usable home the launcher keeps its path, and other messages are unchanged", () => {
  for (const homeDir of ["", "/", "relative/home"]) {
    expect(nativeBuilderSetupCommand({ launcher: managed, homeDir })).toBe(
      `${HOME}/.hack-next/bin/hack-next native setup --accept-downloads`
    );
  }
  expect(
    homeRelativeLauncherCommand({
      launcher: managed,
      args: ["up", "--path", "my project"],
      homeDir: HOME,
    })
  ).toBe("~/.hack-next/bin/hack-next up --path 'my project'");
  // Messages that are not about the builder still name the launcher by its
  // full path, as before.
  expect(nativeSetupGuidance({ state: "not_set_up" }, managed)).toBe(
    `Native runtime is not set up; run ${HOME}/.hack-next/bin/hack-next native setup.`
  );
  expect(nativeBuilderChangedRemedy({ launcher: managed, homeDir: HOME })).toBe(
    "Remove the image builder's directory and record from .hack-local/providers in the native home, then run ~/.hack-next/bin/hack-next native setup --accept-downloads."
  );
});

test("the detached refusal names the same command and no home path", () => {
  // `hack up -d` gets only the failure's code from its owner process, so this
  // sentence is all the user sees there.
  const text = nativeBuilderMissingDetachedRefusal({
    launcher: managed,
    homeDir: HOME,
  });
  expect(text).toBe(
    "Native detached startup refused (builder_not_prepared): the image builder is not installed in this native home, so no image was built and no service was started. Run ~/.hack-next/bin/hack-next native setup --accept-downloads to add it; offline, add --builder <pinned builder file> to the offline setup inputs."
  );
  expect(text).not.toContain(HOME);
  expect(
    nativeBuilderMissingDetachedRefusal({ launcher: stable, homeDir: HOME })
  ).toContain("Run hack native setup --accept-downloads to add it;");
});
