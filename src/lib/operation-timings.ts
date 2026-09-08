/** Numeric, request-local timings. Never records command arguments or payloads. */
export function createOperationTimings() {
  const timings: Record<string, number> = {};
  function record(name: string, started: number): void {
    timings[name] = (timings[name] ?? 0) + performance.now() - started;
  }
  return {
    timings,
    async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
      const started = performance.now();
      try {
        return await operation();
      } finally {
        record(name, started);
      }
    },
    measureSync<T>(name: string, operation: () => T): T {
      const started = performance.now();
      try {
        return operation();
      } finally {
        record(name, started);
      }
    },
  };
}

export type OperationTimings = ReturnType<typeof createOperationTimings>;
