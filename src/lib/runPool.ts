/**
 * Выполняет задачу для каждого элемента, не больше `concurrency` одновременно.
 *
 * Задачи берутся по порядку, но завершаются как придётся. Сбой одной не
 * останавливает остальные: пул дорабатывает всё и в конце бросает первую
 * ошибку, чтобы вызывающий код не терял работу из-за одной строки. Задача,
 * которой нужно пережить собственный сбой, ловит его сама.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let next = 0;
  let firstError: unknown;
  let failed = false;

  async function lane(): Promise<void> {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await task(item as T);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  if (failed) throw firstError;
}
