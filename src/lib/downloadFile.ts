/**
 * Сохраняет файл из памяти: ссылка на временный объект, клик, и объект отпускается руками — иначе вкладка держит файл в памяти.
 * Только для браузера; вызывать из обработчика нажатия.
 */
export function saveBytes(bytes: BlobPart, fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const link = window.document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
