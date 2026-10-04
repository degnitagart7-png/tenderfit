import type { ImportedTender, Tender, TenderLaw } from "@/domain/entities";
import { UNKNOWN_CUSTOMER, UNKNOWN_REGION } from "@/domain/entities";
import type { PlacingWay } from "@/domain/enums";
import { buildEisUrl } from "@/domain/enums";

/**
 * Импорт закупок: разбор CSV и конвертация импортированного черновика
 * в доменную сущность Tender. Чистые функции — без React и хранилищ.
 *
 * Поддерживается CSV с русскими заголовками (разделитель , или ;) —
 * формат выгрузки из таблиц и агрегаторов. Обязательные колонки:
 * «Реестровый номер», «Предмет», «НМЦК»; остальное можно оставить пустым.
 */

const HEADER_ALIASES: Record<string, string> = {
  "реестровый номер": "regNumber",
  "номер извещения": "regNumber",
  регномер: "regNumber",
  закон: "law",
  "44/223": "law",
  "способ определения": "placingWay",
  "способ закупки": "placingWay",
  процедура: "placingWay",
  "вид процедуры": "placingWay",
  "способ определения поставщика": "placingWay",
  предмет: "subject",
  наименование: "subject",
  заказчик: "customerName",
  "инн заказчика": "customerInn",
  inn: "customerInn",
  регион: "region",
  "место поставки": "region",
  нмцк: "price",
  "начальная цена": "price",
  "цена контракта": "price",
  окпд2: "okpd2Codes",
  "код окпд2": "okpd2Codes",
  "окончание подачи": "submissionEnd",
  "дата окончания подачи": "submissionEnd",
  "срок поставки": "deliveryTermDays",
  "дней до": "submissionEnd",
  "текст документации": "documentsText",
  документация: "documentsText",
};

export interface CsvParseResult {
  rows: ImportedTender[];
  errors: { line: number; message: string }[];
}

/** Разбор одной CSV-строки с поддержкой кавычек. */
export function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** «1 200 000,50» / «1200000.5» → число. */
export function parseImportedNumber(raw: string): number | null {
  const cleaned = raw.replace(/\s|\u00a0/g, "").replace(",", ".");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function detectDelimiter(headerLine: string): string {
  const semis = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  return semis >= commas ? ";" : ",";
}

function normalizeLaw(raw: string): TenderLaw {
  const s = raw.toLowerCase().replace(/\s/g, "");
  if (s.includes("223")) return "FZ_223";
  if (s.includes("615")) return "PP_RF_615";
  return "FZ_44";
}

/**
 * Распознаёт способ определения поставщика из текста в CSV.
 * Принимает русские названия процедур («Электронный аукцион», «Конкурс» и т.д.)
 * и возвращает доменный тип PlacingWay. Если не удалось распознать — OTHER.
 */
export function parseImportedPlacingWay(raw: string): PlacingWay {
  const t = raw.toLowerCase().trim();
  if (!t) return "OTHER";
  if (t.includes("аукцион")) return "ELECTRONIC_AUCTION";
  if (t.includes("конкурс")) return "OPEN_CONTEST";
  if (t.includes("котиров")) return "REQUEST_FOR_QUOTATION";
  if (t.includes("предложен")) return "REQUEST_FOR_PROPOSALS";
  if (t.includes("единствен")) return "SOLE_SUPPLIER";
  return "OTHER";
}

/** Дата из CSV → ISO. Принимает ISO, «дд.мм.гггг» и «дд.мм.гг». */
export function parseImportedDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (dmy) {
    const year = Number(dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]);
    const d = new Date(Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1]), 10, 0));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

export function parseTendersCsv(csv: string): CsvParseResult {
  const errors: CsvParseResult["errors"] = [];
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return { rows: [], errors: [{ line: 1, message: "CSV пуст или нет строки данных" }] };
  }
  const delimiter = detectDelimiter(lines[0] as string);
  const header = parseCsvLine(lines[0] as string, delimiter).map((h) =>
    (HEADER_ALIASES[h.toLowerCase()] ?? h.toLowerCase()),
  );
  const col = (name: string): number => header.indexOf(name);

  const rows: ImportedTender[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i] as string, delimiter);
    const get = (name: string): string => {
      const idx = col(name);
      return idx >= 0 ? (cells[idx] ?? "") : "";
    };
    const regNumber = get("regNumber");
    const subject = get("subject");
    if (!regNumber || !subject) {
      errors.push({ line: i + 1, message: "Пропущены обязательные колонки (реестровый номер/предмет)" });
      continue;
    }
    const price = parseImportedNumber(get("price"));
    if (price === null) {
      errors.push({ line: i + 1, message: `Не разобрана НМЦК в строке ${i + 1}` });
      continue;
    }
    const submissionEnd = parseImportedDate(get("submissionEnd"));
    if (!submissionEnd) {
      errors.push({ line: i + 1, message: `Не разобрана дата окончания подачи в строке ${i + 1}` });
      continue;
    }
    const deliveryRaw = parseImportedNumber(get("deliveryTermDays"));
    const placingWay = parseImportedPlacingWay(get("placingWay"));
    rows.push({
      id: `imp-${regNumber}`,
      regNumber,
      law: normalizeLaw(get("law")),
      placingWay,
      subject,
      customerName: get("customerName") || UNKNOWN_CUSTOMER,
      customerInn: get("customerInn") || null,
      region: get("region") || UNKNOWN_REGION,
      price,
      okpd2Codes: get("okpd2Codes")
        ? get("okpd2Codes")
            .split(/[,;]+/)
            .map((c) => c.trim())
            .filter(Boolean)
        : [],
      submissionEnd,
      deliveryTermDays: deliveryRaw !== null ? Math.round(deliveryRaw) : null,
      documentsText: get("documentsText"),
      importedAt: new Date().toISOString(),
      source: "CSV",
    });
  }
  return { rows, errors };
}

/** Конвертация импортированного черновика в доменную закупку (для анализа). */
export function importedToTender(imp: ImportedTender): Tender {
  const isoDay = (d: string) => `${d.slice(0, 10)}`;
  const placingWay = imp.placingWay;
  return {
    id: imp.id,
    regNumber: imp.regNumber,
    externalId: imp.regNumber,
    law: imp.law,
    placingWay,
    subject: imp.subject,
    customerName: imp.customerName,
    customerInn: imp.customerInn,
    region: imp.region,
    deliveryAddress: imp.region,
    financial: {
      price: imp.price,
      currency: "RUB",
      advancePercent: null,
      advanceAmount: null,
      paymentTermDays: 0,
      postpaymentDays: null,
      bidSecurityAmount: null,
      bidSecurityPercent: null,
      contractSecurityAmount: null,
      contractSecurityPercent: null,
      treasurySupport: false,
      expectedMarginPercent: null,
    },
    deadlines: {
      submissionEnd: imp.submissionEnd,
      publicationDate: isoDay(imp.importedAt),
      lastUpdateDate: isoDay(imp.importedAt),
      deliveryTermDays: imp.deliveryTermDays,
      warrantyMonths: null,
    },
    okpd2Codes: imp.okpd2Codes,
    lots: [],
    requirements: [],
    documents: imp.documentsText
      ? [
          {
            id: `${imp.id}-doc-imported`,
            type: "OTHER",
            title: "Импортированная документация",
            fileName: "import.txt",
            url: "",
            text: imp.documentsText,
            pageCount: null,
            lastModified: null,
          },
        ]
      : [],
    nationalRegime: false,
    onlyForSmp: false,
    eisUrl: buildEisUrl(imp.law, imp.regNumber, placingWay),
    dataSource: "IMPORT",
    changeLog: [],
    // Метки партии у импорта нет: такие закупки не приходят прогоном источника.
    // Первым появлением считаем дату импорта — иначе они проваливались бы в
    // «неизвестно когда» и терялись в конце списка.
    syncedAt: null,
    firstSeenAt: imp.importedAt,
  };
}
