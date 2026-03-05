export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncateOutput(value: string, maxChars: number = 12000): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n... [truncated ${omitted} chars]`;
}

export function parsePhpunitStats(output: string): { testsRun: number | null; failures: number } {
  const summaryLine = output.match(/Tests:\s*([0-9]+)[^\n]*/m)?.[0] ?? "";
  if (summaryLine) {
    const testsRun = Number(summaryLine.match(/Tests:\s*([0-9]+)/)?.[1] ?? Number.NaN);
    const failures = Number(summaryLine.match(/Failures:\s*([0-9]+)/)?.[1] ?? 0);
    const errors = Number(summaryLine.match(/Errors:\s*([0-9]+)/)?.[1] ?? 0);
    return {
      testsRun: Number.isFinite(testsRun) ? testsRun : null,
      failures: failures + errors
    };
  }

  const okMatch = output.match(/OK\s+\(([0-9]+)\s+tests?/i);
  if (okMatch) {
    const testsRun = Number(okMatch[1]);
    return {
      testsRun: Number.isFinite(testsRun) ? testsRun : null,
      failures: 0
    };
  }

  return {
    testsRun: null,
    failures: output.includes("FAILURES!") ? 1 : 0
  };
}
