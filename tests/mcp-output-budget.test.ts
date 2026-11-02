import { expect, test } from "bun:test";
import { createMcpOutputBudget } from "../src/mcp/output-budget.ts";

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test("MCP capture accepts exact-budget output without marking it truncated", async () => {
  let stops = 0;
  const budget = createMcpOutputBudget({
    maxBytes: 4,
    onLimit: () => {
      stops++;
    },
  });
  expect(await new Response(budget.wrap(stream("okay"))).text()).toBe("okay");
  expect(budget.exceeded()).toBe(false);
  expect(stops).toBe(0);
});

test("MCP capture shares a byte limit across stdout and stderr and stops only once", async () => {
  let stops = 0;
  const budget = createMcpOutputBudget({
    maxBytes: 6,
    onLimit: () => {
      stops++;
    },
  });
  expect(await new Response(budget.wrap(stream("out"))).text()).toBe("out");
  expect(await new Response(budget.wrap(stream("errors"))).text()).toBe("err");
  expect(await new Response(budget.wrap(stream("more"))).text()).toBe("");
  expect(budget.exceeded()).toBe(true);
  expect(stops).toBe(1);
});

test("MCP capture bounds newline-free bytes before text decoding", async () => {
  const budget = createMcpOutputBudget({
    maxBytes: 5,
    onLimit: () => undefined,
  });
  const result = await new Response(
    budget.wrap(stream("é".repeat(1000)))
  ).arrayBuffer();
  expect(result.byteLength).toBe(5);
  expect(budget.exceeded()).toBe(true);
});
