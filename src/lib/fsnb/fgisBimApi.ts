import { FGIS_BASE } from "@/lib/fsnb/fgisZoneApi";

/**
 * Адреса и разбор ответов ФГИС ЦС для метода БИМ: набор ФСНБ-2020 (ФЕР в уровне 2001) и дерево писем
 * Минстроя с индексами пересчёта.
 *
 * Чистые функции: сеть, диск и pdftotext — дело скриптов `build-fer2020.ts` и `fetch-bim-indices.ts`.
 * Дерево писем разбирается терпимо: формы ответа сервера на момент написания этого кода без доступа
 * к нему (только с российского IP) известны лишь по описанию — узлы с `filePath` это письма, узлы
 * без него — папки; имена полей читаются из нескольких вариантов, а непонятный узел пропускается, а не
 * роняет обход. Что именно вернул сервер, видно по `--dump-tree` в `fetch-bim-indices.ts`.
 */

/** Открытый набор данных 7707082071-fsnbfer: «ФСНБ-2020 включая дополнение №9, действует с 01.02.2022» (datasetFile id=3). */
export const FER2020_ZIP_PATH = "6b5f31bd-879d-4578-bb7e-bcfb64cd8bbf";

export function fileContentUrl(path: string): string {
  return `${FGIS_BASE}/api/values/GetFileContent/${encodeURIComponent(path).replace(/%2F/gi, "/")}`;
}

export function fer2020ZipUrl(): string {
  return fileContentUrl(FER2020_ZIP_PATH);
}

/**
 * Узел дерева нормативных документов («Индексы изменения сметной стоимости…»): тип 10, состояние 20,
 * вид документа 40. Без `parentGuid` — корень.
 */
export function normLegalDocUrl(parentGuid: string | null): string {
  const query = "normLegalDocPublishedType=10&state=20&normLegalDocBaseKind=40";
  return `${FGIS_BASE}/api/NormLegalDocPublished?${query}${parentGuid === null ? "" : `&parentGuid=${encodeURIComponent(parentGuid)}`}`;
}

export interface DocNode {
  readonly guid: string;
  readonly name: string;
  /** Путь файла для `GetFileContent`; у папок пуст. */
  readonly filePath: string | null;
  /** Дата и номер письма, если сервер их отдал. */
  readonly date: string | null;
  readonly number: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = text(record[key]);
    if (found !== null) return found;
  }
  return null;
}

/** Список узлов из ответа: массив или объект с `items` / `data` / `result` / `children`. */
export function parseDocNodes(payload: unknown): DocNode[] {
  let list: unknown = payload;
  if (!Array.isArray(list) && typeof list === "object" && list !== null) {
    const record = list as Record<string, unknown>;
    // Живой ответ ФГИС ЦС (проверено 09.10.2026): `{"": [...]}` — массив под пустым ключом.
    list =
      record.items ??
      record.data ??
      record.result ??
      record.children ??
      record[""] ??
      Object.values(record).find((value) => Array.isArray(value)) ??
      [];
  }
  if (!Array.isArray(list)) return [];
  const nodes: DocNode[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const guid = pick(record, ["guid", "id", "uid", "key"]);
    const name = pick(record, ["name", "title", "shortName", "fullName", "caption", "text"]);
    if (guid === null && name === null) continue;
    nodes.push({
      guid: guid ?? name ?? "",
      name: name ?? "",
      filePath: pick(record, ["filePath", "path", "fileUrl"]),
      date: pick(record, ["date", "docDate", "approveDate", "approvalDate"]),
      number: pick(record, ["number", "docNumber", "approveNumber"]),
    });
  }
  return nodes;
}

const ROMAN: Readonly<Record<string, number>> = { I: 1, II: 2, III: 3, IV: 4 };

/** Квартал из имени узла: «III квартал», «3 квартал 2026», «3 кв.»; нет — null. */
export function quarterOfNodeName(name: string): number | null {
  const match = /(?:^|[^\p{L}\d])(IV|III|II|I|[1-4])\s*(?:-?й\s*)?(?:квартал|кв(?![а-яё]))/iu.exec(name);
  if (match?.[1] === undefined) return null;
  const raw = match[1].toUpperCase();
  return ROMAN[raw] ?? Number.parseInt(raw, 10);
}

/** Год из имени узла: «2026», «2026 год»; нет — null. */
export function yearOfNodeName(name: string): number | null {
  const match = /(?<!\d)(20\d{2})(?!\d)/.exec(name);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

/** Узел-папка «по объектам строительства» — там лежат письма с индексами по элементам прямых затрат. */
export function isByObjectsNode(name: string): boolean {
  return /по\s+объектам\s+строительства/iu.test(name);
}
