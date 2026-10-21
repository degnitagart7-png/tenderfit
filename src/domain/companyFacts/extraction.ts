import { COMPANY_DOCUMENT_CATEGORY_LABELS, type CompanyDocumentCategory } from "@/domain/companyFacts/types";

/**
 * Подготовка запросов к модели для извлечения фактов: порядок документов, бюджет знаков, нарезка и промпт.
 *
 * Бюджет. Всего в модель уходит не больше `TOTAL_CHAR_BUDGET` знаков очищенного текста (сто двадцать тысяч — около
 * 50 тыс. токенов, на цене Haiku это порядка 6 ₽ в худшем случае). Документы берутся по важности для сверки с закупкой:
 * СРО и лицензии, опыт, потом прайс, кадры, техника, остальное. Что не поместилось — не молча теряется, а возвращается
 * списком «не вошло», и человек видит это в интерфейсе.
 *
 * Нарезка. Документ длиннее `CHUNK_CHARS` режется по границам абзацев. Один запрос несёт до `CALL_CHAR_BUDGET` знаков;
 * прайс-листы идут отдельными запросами, потому что ответ по ним самый длинный (строка на позицию) и не должен
 * соседствовать с остальными документами в одном лимите токенов.
 *
 * Названия файлов в запрос не попадают: «Резюме_Иванов.pdf» — это тоже ФИО. Документы называются «Документ 1» и т. д.
 */

export const TOTAL_CHAR_BUDGET = 120_000;
export const CALL_CHAR_BUDGET = 45_000;
export const CHUNK_CHARS = 40_000;
export const PRICE_CHUNK_CHARS = 28_000;

/** Документы, у которых после очистки меньше этого, в запрос не идут: там читать нечего. */
export const MIN_USEFUL_CHARS = 40;

const CATEGORY_PRIORITY: readonly CompanyDocumentCategory[] = ["sro", "license", "experience", "price", "staff", "equipment", "financial", "other"];

export interface ExtractionDocument {
  id: string;
  name: string;
  category: CompanyDocumentCategory;
  /** Очищенный от ПД текст. */
  text: string;
}

export interface ExtractionPiece {
  documentId: string;
  /** «Документ 3»: так модель видит документ. */
  label: string;
  category: CompanyDocumentCategory;
  text: string;
}

export interface ExtractionPlan {
  /** Запросы к модели: каждый — набор кусков. */
  batches: ExtractionPiece[][];
  /** Документы, которые вошли (хотя бы частично). */
  included: string[];
  /** Документы, которые не вошли, и почему. */
  skipped: { id: string; name: string; reason: string }[];
  /** Сколько знаков уйдёт в модель всего (без служебного текста промпта). */
  sentChars: number;
  /** Часть текста отрезана по бюджету. */
  truncated: boolean;
}

/** Режет текст по абзацам на куски не длиннее `max`; слишком длинный абзац режется по границе слов. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim() !== "") chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n+/u)) {
    if (paragraph.length > max) {
      // Абзац длиннее куска (таблица одной строкой): режем по границе слов.
      flush();
      let rest = paragraph;
      while (rest.length > max) {
        const space = rest.lastIndexOf(" ", max);
        const at = space > max * 0.5 ? space : max;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trimStart();
      }
      current = `${rest}\n`;
      continue;
    }
    if (current.length + paragraph.length + 1 > max) flush();
    current += `${paragraph}\n`;
  }
  flush();
  return chunks;
}

export function planExtraction(documents: readonly ExtractionDocument[]): ExtractionPlan {
  const skipped: ExtractionPlan["skipped"] = [];
  const included: string[] = [];
  const ordered = documents
    .map((document, index) => ({ document, index, rank: CATEGORY_PRIORITY.indexOf(document.category) }))
    .sort((a, b) => (a.rank < 0 ? 99 : a.rank) - (b.rank < 0 ? 99 : b.rank) || a.index - b.index);

  let budget = TOTAL_CHAR_BUDGET;
  let truncated = false;
  const pieces: ExtractionPiece[] = [];
  let label = 0;

  for (const { document } of ordered) {
    const text = document.text.trim();
    if (text.length < MIN_USEFUL_CHARS) {
      skipped.push({ id: document.id, name: document.name, reason: "после очистки текста почти не осталось" });
      continue;
    }
    if (budget <= 0) {
      skipped.push({ id: document.id, name: document.name, reason: "не поместился в лимит объёма" });
      truncated = true;
      continue;
    }
    label += 1;
    const chunkSize = document.category === "price" ? PRICE_CHUNK_CHARS : CHUNK_CHARS;
    let usedAny = false;
    for (const chunk of chunkText(text, chunkSize)) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const part = chunk.length > budget ? chunk.slice(0, budget) : chunk;
      if (part.length < chunk.length) truncated = true;
      budget -= part.length;
      pieces.push({ documentId: document.id, label: `Документ ${String(label)}`, category: document.category, text: part });
      usedAny = true;
    }
    if (usedAny) included.push(document.id);
  }

  // Упаковка в запросы: прайс — по куску на запрос, остальное — пока влезает.
  const batches: ExtractionPiece[][] = [];
  let open: ExtractionPiece[] = [];
  let openChars = 0;
  for (const piece of pieces) {
    if (piece.category === "price") {
      batches.push([piece]);
      continue;
    }
    if (open.length > 0 && openChars + piece.text.length > CALL_CHAR_BUDGET) {
      batches.push(open);
      open = [];
      openChars = 0;
    }
    open.push(piece);
    openChars += piece.text.length;
  }
  if (open.length > 0) batches.push(open);

  return {
    batches,
    included,
    skipped,
    sentChars: pieces.reduce((sum, piece) => sum + piece.text.length, 0),
    truncated,
  };
}

const SCHEMA = `{
  "work_types": [{"name": "вид работ", "contracts_count": 0, "total_sum_rub": 0, "years": [2023], "largest_contract_rub": 0}],
  "contracts": [{"subject": "предмет контракта", "work_type": "вид работ", "customer_type": "government|municipal|state_company|commercial|unknown", "customer": "организация-заказчик", "year": 2024, "sum_rub": 0, "law": "44-FZ|223-FZ|commercial|unknown", "region": "регион"}],
  "sro": [{"kind": "CONSTRUCTION|DESIGN|SURVEY|OTHER", "level": 1, "max_contract_rub": 0, "number": "номер в реестре СРО", "valid_until": "YYYY-MM-DD"}],
  "licenses": [{"kind": "на что лицензия", "issuer": "орган", "number": "номер", "valid_until": "YYYY-MM-DD"}],
  "equipment": [{"name": "техника или оборудование", "count": 0}],
  "staff": [{"role": "должность или специальность", "count": 0, "qualification": "квалификация, разряд, реестр НРС/НОПРИЗ"}],
  "staff_total": 0,
  "prices": [{"name": "работа или материал", "unit": "ед. изм.", "price_rub": 0, "code": "шифр или артикул", "kind": "work|material|other", "vat": "with|without|unknown"}],
  "regions": ["регион, где компания работала"],
  "notes": ["иное важное для участия в закупках"]
}`;

export function buildFactsPrompt(batch: readonly ExtractionPiece[]): string {
  const documents = batch
    .map((piece) => `=== ${piece.label} (тип: ${COMPANY_DOCUMENT_CATEGORY_LABELS[piece.category]}) ===\n${piece.text}`)
    .join("\n\n");
  return [
    "Ты извлекаешь деловые факты о подрядной (строительной) компании из её документов: прайс-листов, реестров и выписок по контрактам, свидетельств СРО, лицензий, сведений о кадрах и технике. Факты нужны, чтобы сверять компанию с требованиями закупок.",
    "",
    "Правила:",
    "1. Верни ТОЛЬКО один JSON-объект по схеме ниже — без пояснений и без ограждения ```.",
    "2. Никаких персональных данных. В тексте ФИО, телефоны, почта, паспортные данные, личные адреса и даты рождения уже заменены метками вроде [ФИО] и [телефон]: метки не переписывай и не угадывай, что за ними стояло. Заказчика-человека (ИП, гражданин) не указывай. В кадрах — только численность по ролям и квалификации, без имён.",
    "3. Только то, что прямо сказано в документах. Не домысливай и не округляй. Нет данных — пустой массив или null.",
    "4. Суммы — числом в рублях без пробелов (12450000); «млн» и «тыс.» переведи в рубли. Год — четыре цифры.",
    "5. Контракты — каждый отдельной записью, если документ их перечисляет. work_type — короткая нормализованная формулировка вида работ («капитальный ремонт кровли», «устройство сетей водоснабжения»). law: 44-FZ, 223-FZ, commercial (коммерческий) или unknown.",
    "6. work_types — сводка по видам работ: число контрактов, общая сумма, годы, самый крупный контракт. Считай только по тому, что видно в документах.",
    "7. СРО: kind — CONSTRUCTION (строительство, реконструкция, капремонт), DESIGN (проектирование), SURVEY (изыскания); level — уровень ответственности 1–5; max_contract_rub — предельная стоимость договора, если указана.",
    "8. prices заполняй, только если документ — прайс-лист или расценки самой компании. code — шифр нормы или артикул, если он есть в строке.",
    "9. staff_total — общая численность штата ровно так, как она названа в документах («Штат: 32 человека»); null, если общего числа нет. Не складывай роли сам: роли перечислены не все.",
    "10. Тип документа в заголовке — подсказка человека, а не гарантия: если внутри другое, опирайся на содержимое.",
    "",
    "Схема ответа (все поля необязательные, массивы могут быть пустыми):",
    SCHEMA,
    "",
    "Документы:",
    documents,
  ].join("\n");
}
