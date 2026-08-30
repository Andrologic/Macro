export type SerialTask<T> = () => Promise<T>;

export const createKeyedSerialQueue = <TKey>() => {
  const tails = new Map<TKey, Promise<void>>();

  return <TResult>(key: TKey, task: SerialTask<TResult>): Promise<TResult> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.finally(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });
    return result;
  };
};

export const createSerialQueue = () => {
  const enqueue = createKeyedSerialQueue<'default'>();
  return <TResult>(task: SerialTask<TResult>): Promise<TResult> => enqueue('default', task);
};
