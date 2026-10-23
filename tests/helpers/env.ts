/** Restore absence without assigning the literal string "undefined" on Bun 1.4.4. */
export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}
