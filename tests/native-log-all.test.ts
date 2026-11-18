import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import {
  followAllNativeServices,
  nativeLogPrefix,
  prefixedLineWriter,
} from "../src/backends/native-log-all.ts";

function sink(): { readonly stream: Writable; readonly text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, text: () => text };
}

function write(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) =>
    stream.write(text, (error) => (error ? reject(error) : resolve()))
  );
}

test("the prefix pads service names to one column", () => {
  expect(nativeLogPrefix({ service: "api", width: 6 })).toBe("api    | ");
});

test("the prefixed writer holds a partial line until its newline and flushes the rest at end", async () => {
  const out = sink();
  const writer = prefixedLineWriter({ target: out.stream, prefix: "api | " });
  await write(writer, "first li");
  expect(out.text()).toBe("");
  await write(writer, "ne\nsecond\n\nthird");
  expect(out.text()).toBe("api | first line\napi | second\napi | \n");
  await new Promise<void>((resolve) => writer.end(resolve));
  expect(out.text()).toBe(
    "api | first line\napi | second\napi | \napi | third\n"
  );
});

test("following every service prefixes each service's output and keeps the streams apart", async () => {
  const out = sink();
  const err = sink();
  const started: string[] = [];
  const code = await followAllNativeServices({
    services: ["api", "worker"],
    json: false,
    stdout: out.stream,
    stderr: err.stream,
    follow: async ({ service, stdout, stderr }) => {
      started.push(service);
      await write(stdout, `${service} ready\n`);
      await write(stderr, `${service} warning\n`);
      return 0;
    },
  });
  expect(code).toBe(0);
  expect(started).toEqual(["api", "worker"]);
  expect(out.text().split("\n").filter(Boolean).sort()).toEqual([
    "api    | api ready",
    "worker | worker ready",
  ]);
  expect(err.text().split("\n").filter(Boolean).sort()).toEqual([
    "api    | api warning",
    "worker | worker warning",
  ]);
});

test("one failing service does not stop the others; a cancellation code wins", async () => {
  const out = sink();
  const finished: string[] = [];
  const failed = await followAllNativeServices({
    services: ["api", "web"],
    json: false,
    stdout: out.stream,
    stderr: out.stream,
    follow: async ({ service }) => {
      if (service === "api") {
        return 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished.push(service);
      return 0;
    },
  });
  expect(failed).toBe(1);
  expect(finished).toEqual(["web"]);
  const canceled = await followAllNativeServices({
    services: ["api", "web"],
    json: false,
    stdout: out.stream,
    stderr: out.stream,
    follow: ({ service }) => Promise.resolve(service === "api" ? 1 : 130),
  });
  expect(canceled).toBe(130);
});

test("JSON follow passes the shared streams through: events already name their service", async () => {
  const out = sink();
  const seen: Writable[] = [];
  await followAllNativeServices({
    services: ["api", "web"],
    json: true,
    stdout: out.stream,
    stderr: out.stream,
    follow: ({ stdout }) => {
      seen.push(stdout);
      return Promise.resolve(0);
    },
  });
  expect(seen).toEqual([out.stream, out.stream]);
});

test("a reader that goes away (EPIPE on the shared stdout) ends every follower quietly", async () => {
  const broken = new Writable({
    write(_chunk, _encoding, done) {
      const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      done(error);
    },
  });
  const seen: boolean[] = [];
  const code = await followAllNativeServices({
    services: ["api", "web"],
    json: false,
    stdout: broken,
    stderr: broken,
    follow: async ({ service, stdout }) => {
      // Like the real follower (logOutput), it listens to its own output.
      stdout.on("error", () => undefined);
      await write(stdout, `${service} line\n`).catch(() => undefined);
      // The follower sees its output closed, as for an ordinary pipe close.
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push(stdout.destroyed);
      return 0;
    },
  });
  expect(code).toBe(0);
  expect(seen).toEqual([true, true]);
});

test("after Ctrl-C a stuck consumer cannot hold follow-all open", async () => {
  // A consumer that stays open but never accepts a write.
  const stuck = new Writable({ write() {} });
  const started = Date.now();
  const code = await followAllNativeServices({
    services: ["api"],
    json: false,
    stdout: stuck,
    stderr: stuck,
    follow: ({ stdout }) => {
      stdout.write("api line\n");
      return Promise.resolve(130);
    },
  });
  expect(code).toBe(130);
  expect(Date.now() - started).toBeLessThan(500);
});

test("a stdout failure other than a closed reader leaves stderr for the follower's diagnostic", async () => {
  const failing = new Writable({
    write(_chunk, _encoding, done) {
      done(Object.assign(new Error("i/o error"), { code: "EIO" }));
    },
  });
  const err = sink();
  const code = await followAllNativeServices({
    services: ["api"],
    json: false,
    stdout: failing,
    stderr: err.stream,
    follow: async ({ stdout, stderr }) => {
      stdout.on("error", () => undefined);
      await write(stdout, "api line\n").catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stderr.destroyed).toBe(false);
      await write(
        stderr,
        "Native logs failed (native_log_stream_uncertain).\n"
      );
      return 1;
    },
  });
  expect(code).toBe(1);
  expect(err.text()).toBe(
    "api | Native logs failed (native_log_stream_uncertain).\n"
  );
});
