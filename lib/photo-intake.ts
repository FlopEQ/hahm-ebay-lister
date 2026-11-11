// Bound decoding/encoding work without losing successful files or their order.
export async function processPhotoIntake<T>(
  files: File[], process: (file: File) => Promise<T>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ photos: T[]; errors: string[] }> {
  const results: { photo: T }[] = new Array(files.length);
  const failures: string[] = new Array(files.length);
  let cursor = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(2, files.length) }, async () => {
    while (cursor < files.length) {
      const index = cursor++;
      try { results[index] = { photo: await process(files[index]) }; }
      catch (error) {
        failures[index] = `${files[index].name}: ${error instanceof Error ? error.message : String(error)}`;
      } finally { onProgress?.(++done, files.length); }
    }
  }));
  return { photos: results.filter(Boolean).map(result => result.photo), errors: failures.filter(Boolean) };
}
