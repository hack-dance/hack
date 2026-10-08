import { expect, test } from "bun:test";
import { nativeComposeFixtureFailureJobMatches } from "./e2e/scenarios/native-config-compose.ts";

function fixture() {
  const expected = {
    containerId: "a".repeat(64),
    composeProject: `hack-nc-${"b".repeat(32)}`,
    ownerToken: "c".repeat(32),
    generationId: "d".repeat(32),
    image: `sha256:${"e".repeat(64)}`,
  };
  return {
    startup: { exitCode: 1, timedOut: false },
    payload: {
      ok: false,
      error: { code: "E_STARTUP_INCOMPLETE" },
    },
    expected,
    job: {
      id: expected.containerId,
      image: expected.image,
      status: "exited",
      exitCode: 17,
      running: false,
      labels: {
        "com.docker.compose.project": expected.composeProject,
        "com.docker.compose.service": "failure",
        "com.docker.compose.oneoff": "False",
        "io.hack.native-config.instance": expected.composeProject,
        "io.hack.native-config.owner": expected.ownerToken,
        "io.hack.native-config.generation": expected.generationId,
        "io.hack.native-config.workload": "job",
        "io.hack.native-config.version": "1",
      },
    },
  };
}

test("failed-dependency fixture requires the pinned pending job's actual exit 17", () => {
  expect(nativeComposeFixtureFailureJobMatches(fixture())).toBe(true);
});

test("the observed interrupted replacement cannot qualify a failed-dependency job", () => {
  const input = fixture();
  expect(
    nativeComposeFixtureFailureJobMatches({
      ...input,
      job: { ...input.job, status: "created", exitCode: 0 },
    })
  ).toBe(false);
});

test.each([
  "created",
  "running",
  "restarting",
  "dead",
  "removing",
])("%s job cannot qualify even if it carries exit 17", (status) => {
  const input = fixture();
  expect(
    nativeComposeFixtureFailureJobMatches({
      ...input,
      job: { ...input.job, status },
    })
  ).toBe(false);
});

test.each([
  0,
  1,
  16,
  18,
  137,
  "17",
  null,
  undefined,
])("wrong job exit %s cannot qualify incomplete startup", (exitCode) => {
  const input = fixture();
  expect(
    nativeComposeFixtureFailureJobMatches({
      ...input,
      job: { ...input.job, exitCode },
    })
  ).toBe(false);
});

test("a timed-out CLI cannot qualify even if a stopped job has exit 17", () => {
  const input = fixture();
  expect(
    nativeComposeFixtureFailureJobMatches({
      ...input,
      startup: { ...input.startup, timedOut: true },
    })
  ).toBe(false);
});

test("unrelated startup errors and success cannot qualify failed-job recovery", () => {
  const input = fixture();
  for (const code of ["E_CONFIG_INVALID", "E_STARTUP_TIMEOUT", undefined]) {
    expect(
      nativeComposeFixtureFailureJobMatches({
        ...input,
        payload: { ok: false, error: { code } },
      })
    ).toBe(false);
  }
  expect(
    nativeComposeFixtureFailureJobMatches({
      ...input,
      startup: { exitCode: 0, timedOut: false },
    })
  ).toBe(false);
});

test.each([
  ["com.docker.compose.project", "foreign-project"],
  ["com.docker.compose.service", "initializer"],
  ["com.docker.compose.oneoff", "True"],
  ["io.hack.native-config.instance", "foreign-project"],
  ["io.hack.native-config.owner", "f".repeat(32)],
  ["io.hack.native-config.generation", "f".repeat(32)],
  ["io.hack.native-config.workload", "service"],
  ["io.hack.native-config.version", "2"],
])("foreign or altered %s cannot qualify the failure job", (name, value) => {
  const input = fixture();
  expect(
    nativeComposeFixtureFailureJobMatches({
      ...input,
      job: {
        ...input.job,
        labels: { ...input.job.labels, [name]: value },
      },
    })
  ).toBe(false);
});

test("another container or image and a still-running job cannot qualify", () => {
  const input = fixture();
  for (const changes of [
    { id: "f".repeat(64) },
    { image: `sha256:${"f".repeat(64)}` },
    { running: true },
  ]) {
    expect(
      nativeComposeFixtureFailureJobMatches({
        ...input,
        job: { ...input.job, ...changes },
      })
    ).toBe(false);
  }
});

test("missing, malformed and inherited job or ownership claims refuse", () => {
  const input = fixture();
  for (const job of [null, [], {}, Object.create(input.job)]) {
    expect(nativeComposeFixtureFailureJobMatches({ ...input, job })).toBe(
      false
    );
  }
  expect(
    nativeComposeFixtureFailureJobMatches({
      ...input,
      job: { ...input.job, labels: Object.create(input.job.labels) },
    })
  ).toBe(false);
  for (const payload of [null, [], {}, Object.create(input.payload)]) {
    expect(nativeComposeFixtureFailureJobMatches({ ...input, payload })).toBe(
      false
    );
  }
});
