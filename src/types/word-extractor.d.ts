/**
 * Минимальное объявление для word-extractor: своих типов пакет не публикует,
 * а `@types/word-extractor` в npm нет. Нужен он ровно для одного — читать
 * старые бинарные .doc, которые мамонт не понимает. Вложения ЕИС сплошь и рядом
 * приходят в .doc: в проверенном архиве из 29 файлов 17 были именно такими.
 */
declare module "word-extractor" {
  /** Разобранный .doc: текст по частям документа. */
  interface ExtractedDocument {
    getBody(): string;
    getHeaders(options?: { includeBody?: boolean }): string;
    getFooters(options?: { includeBody?: boolean }): string;
    getAnnotations(): string;
    getTextboxes(): string;
    getEndnotes(): string;
    getFootnotes(): string;
    getHeadersTextboxes(): string;
    getFootersTextboxes(): string;
  }

  export default class WordExtractor {
    extract(input: Uint8Array | Buffer | string): Promise<ExtractedDocument>;
  }
}
