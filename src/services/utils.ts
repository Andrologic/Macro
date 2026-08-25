export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const maybeFail = (rate: number) => {
  if (rate <= 0) return;
  if (Math.random() < rate) {
    throw Object.assign(new Error('Simulated backend error'), {
      code: 'MOCK_ERROR',
      details: { rate },
    });
  }
};
