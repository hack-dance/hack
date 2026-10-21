import { expect } from "bun:test";
import {
  ClosedCliError,
  HackCliError,
  type HackErrorCode,
} from "../../src/lib/cli-result.ts";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
}

/**
 * Awaits a rejection that must be a known, value-free refusal: a
 * {@link ClosedCliError}, which the CLI prints as its message alone, without a
 * stack. A plain `Error` with the same text fails, so these assertions catch a
 * refusal that regresses to an unexpected exception.
 */
export async function expectClosedRefusal(
  promise: Promise<unknown>,
  text: string
): Promise<ClosedCliError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ClosedCliError);
  expect(error).toHaveProperty("message", expect.stringContaining(text));
  return error as ClosedCliError;
}

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (caught: unknown) {
    return caught;
  }
  return undefined;
}

/** Synchronous form of {@link expectClosedRefusal}. */
export function expectClosedThrow(
  action: () => unknown,
  text: string
): ClosedCliError {
  const error = thrown(action);
  expect(error).toBeInstanceOf(ClosedCliError);
  expect(error).toHaveProperty("message", expect.stringContaining(text));
  return error as ClosedCliError;
}

/** Synchronous form of {@link expectCodedRefusal}. */
export function expectCodedThrow(
  action: () => unknown,
  code: HackErrorCode,
  text: string
): HackCliError {
  const error = thrown(action);
  expect(error).toBeInstanceOf(HackCliError);
  expect(error).toHaveProperty("code", code);
  expect(error).toHaveProperty("message", expect.stringContaining(text));
  return error as HackCliError;
}

/** Like {@link expectClosedRefusal}, for a refusal with a stable `--json` code. */
export async function expectCodedRefusal(
  promise: Promise<unknown>,
  code: HackErrorCode,
  text: string
): Promise<HackCliError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(HackCliError);
  expect(error).toHaveProperty("code", code);
  expect(error).toHaveProperty("message", expect.stringContaining(text));
  return error as HackCliError;
}
