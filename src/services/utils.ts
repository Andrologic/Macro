export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const maybeFail = (rate: number) => {
  if (rate <= 0) return;
  if (Math.random() < rate) {
    throw {
      code: 'MOCK_ERROR',
      message: 'Simulated backend error',
      details: { rate },
    };
  }
};
