export function distribution(values: number[]) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Expected nonempty finite, nonnegative samples');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1)! };
}

export function benchmark(run: () => unknown, warmup = 10, samples = 100) {
  for (let i = 0; i < warmup; i++) run();
  const durations = Array.from({ length: samples }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  });
  return { unit: 'ms', warmup, ...distribution(durations) };
}
