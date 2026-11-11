import { describe, expect, test } from "bun:test";
import {
  composeEnvValuesToRedact,
  composePsTextFallbackAllowed,
  firstEngineLine,
  parseComposePsJson,
  readComposePs,
  readComposePsResult,
} from "../src/lib/compose-ps-result.ts";

function failure(stderr: string, exitCode = 1, stdout = "") {
  const read = readComposePsResult({ result: { exitCode, stdout, stderr } });
  if (read.ok) {
    throw new Error("expected a failure");
  }
  return read.error;
}

describe("readComposePsResult", () => {
  test("classifies a denied Docker socket as E_PERMISSION with the engine line", () => {
    const error = failure(
      "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock\nmore\n"
    );
    expect(error.code).toBe("E_PERMISSION");
    expect(error.message).toContain("docker group");
    expect(error.message).toEndWith(
      "Engine said: permission denied while trying to connect to the docker API at unix:///var/run/docker.sock"
    );
    expect(composePsTextFallbackAllowed(error)).toBe(false);
  });

  test("a denied Compose input is E_PERMISSION without the socket advice", () => {
    const error = failure("open /tmp/x/compose.yml: permission denied");
    expect(error.code).toBe("E_PERMISSION");
    expect(error.message).not.toContain("docker group");
    expect(error.message).toContain("compose.yml: permission denied");
  });

  test.each([
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    "failed to connect to the docker API at unix:///run/user/1000/docker.sock; check if the path is correct and if the daemon is running: dial unix /run/user/1000/docker.sock: connect: no such file or directory",
    "error during connect: Get http://127.0.0.1:2375/v1.47/containers/json: dial tcp 127.0.0.1:2375: connect: connection refused",
  ])("classifies an unreachable engine as E_DOCKER_UNAVAILABLE: %s", (line) => {
    const error = failure(line);
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error.message).toContain(`Engine said: ${line}`);
    expect(composePsTextFallbackAllowed(error)).toBe(false);
  });

  test("a timed-out read (exit 124) is E_DOCKER_UNAVAILABLE", () => {
    expect(failure("", 124).code).toBe("E_DOCKER_UNAVAILABLE");
  });

  test("any other failure is E_COMPOSE_FAILED and allows the text fallback", () => {
    const error = failure(
      "\u001b[31mno configuration file provided\u001b[0m",
      14
    );
    expect(error.code).toBe("E_COMPOSE_FAILED");
    expect(error.message).toBe(
      "docker compose ps failed (exit 14). Engine said: no configuration file provided"
    );
    expect(composePsTextFallbackAllowed(error)).toBe(true);
  });

  test("unparsable output is E_COMPOSE_OUTPUT_INVALID and is not echoed", () => {
    const read = readComposePsResult({
      result: {
        exitCode: 0,
        stdout: '{"Service":"web"}\nweb  running  SECRET_TEXT\n',
        stderr: "",
      },
    });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe("E_COMPOSE_OUTPUT_INVALID");
      expect(read.error.message).not.toContain("SECRET_TEXT");
      expect(composePsTextFallbackAllowed(read.error)).toBe(true);
    }
  });

  test("empty output is an empty listing", () => {
    expect(
      readComposePsResult({ result: { exitCode: 0, stdout: "\n", stderr: "" } })
    ).toEqual({ ok: true, entries: [] });
  });
});

describe("parseComposePsJson", () => {
  test("reads JSON lines and the older single-array form", () => {
    expect(parseComposePsJson('{"Service":"a"}\n{"Service":"b"}\n')).toEqual([
      { Service: "a" },
      { Service: "b" },
    ]);
    expect(parseComposePsJson('[{"Service":"a"},{"Service":"b"}]')).toEqual([
      { Service: "a" },
      { Service: "b" },
    ]);
  });

  test.each(["[1]", '"text"', "null", "{"])("refuses %s", (line) => {
    expect(parseComposePsJson(line)).toBeNull();
  });
});

describe("firstEngineLine", () => {
  test("redacts URL credentials and named values, then bounds the length", () => {
    const line = firstEngineLine({
      result: {
        exitCode: 1,
        stdout: "",
        stderr: `error during connect: tcp://user:pa55@host:2376 token=sample-env-value ${"x".repeat(400)}`,
      },
      redactValues: ["sample-env-value", "abc"],
    });
    expect(line).toStartWith(
      "error during connect: tcp://[REDACTED]@host:2376 token=[REDACTED] "
    );
    expect(line).not.toContain("pa55");
    expect(line).not.toContain("sample-env-value");
    expect(line?.length).toBe(240);
    expect(line).toEndWith("…");
  });

  test("falls back to stdout and returns null when both are empty", () => {
    expect(
      firstEngineLine({
        result: { exitCode: 1, stdout: "\n  from stdout\n", stderr: " \n" },
      })
    ).toBe("from stdout");
    expect(
      firstEngineLine({ result: { exitCode: 1, stdout: "", stderr: "" } })
    ).toBeNull();
  });
});

test("composeEnvValuesToRedact keeps only values Hack added or changed", () => {
  expect(
    composeEnvValuesToRedact({
      env: { HOME: "<home>", HACK_ENV_TOKEN: "added", PATH: "changed" },
      inherited: { HOME: "<home>", PATH: "/usr/bin" },
    }).sort()
  ).toEqual(["added", "changed"]);
  expect(composeEnvValuesToRedact({ env: undefined })).toEqual([]);
});

test("readComposePs reports a missing docker CLI as E_DOCKER_UNAVAILABLE", async () => {
  const read = await readComposePs({
    run: () => Promise.reject(new Error("ENOENT: docker")),
  });
  expect(read.ok).toBe(false);
  if (!read.ok) {
    expect(read.error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(read.error.message).toContain("not installed or not on PATH");
  }
});
