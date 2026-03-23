import { expect, test } from "bun:test";

import { generateTicketId } from "../src/control-plane/extensions/tickets/util.ts";

test("generateTicketId never emits an all-digit suffix", () => {
  const ticketId = generateTicketId();

  expect(ticketId).toMatch(/^T-[0-9A-Z]{10}$/);
  expect(ticketId).not.toMatch(/^T-\d{10}$/);
});
