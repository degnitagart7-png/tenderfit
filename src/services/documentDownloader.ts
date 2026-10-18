import { gatedEisFetch } from "@/lib/eisGate";

interface DownloadResult {
  buffer: Buffer;
  mimeType: string | null;
  fileSize: number;
}

/**
 * Download a document from a URL and return its buffer + metadata.
 *
 * cache: "no-store" — Next.js кэширует fetch по URL, и документ закупки
 * обязан скачиваться заново, а не доставаться из кэша прошлой закупки.
 */
export async function downloadDocument(url: string): Promise<DownloadResult> {
  // Файлы ЕИС идут через общий затвор: блокировка (434/403/429) превращается в
  // EisBlockedError, а пока идёт карантин, сетевого вызова нет. Чужие адреса
  // затвор пропускает без изменений.
  const response = await gatedEisFetch(url, () => fetch(url, { cache: "no-store" }));

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");
  const fileSize = contentLength ? parseInt(contentLength, 10) : buffer.length;

  return { buffer, mimeType, fileSize };
}
