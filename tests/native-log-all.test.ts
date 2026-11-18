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
