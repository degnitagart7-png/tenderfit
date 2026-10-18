import { decodeXmlEntities, type XmlAttributes, type XmlToken } from "@/lib/fsnb/xmlTokenizer";

/**
 * Разбор выгрузки ФСНБ-2020 («ФЕР.xml», «ФЕРм.xml», «ФЕРр.xml», «ФЕРп.xml», «ФЕРмр.xml»,
 * «ФССЦ.xml», «ФСЭМ.xml», «ФССЦпг.xml») в компактные записи базисного уровня цен 2001 года.
 *
 * Это основа метода БИМ (базисно-индексного): единичные расценки ФЕР-2001 в ценах на 01.01.2000,
 * которые потом умножаются на индексы письма Минстроя по субъекту и объекту. Структура проверена
 * на реальной выгрузке «ФСНБ-2020 включая дополнение №9, действует с 01.02.2022», а не взята из
 * описания:
 *
 *   <base PriceLevel="01.01.2000" BaseType="ФЕР">
 *     <ResourcesDirectory><ResourceCategory CodePrefix="ФЕР">
 *       <Section Type="Сборник" Code="01" Name="Земляные работы">
 *         … <Section Type="Таблица" Code="01-01-001" …>
 *           <NameGroup BeginName="Разработка грунта …">
 *             <Work Code="01-01-001-01" EndName="…" MeasureUnit="1000 м3">
 *               <Resources>
 *                 <Resource Code="1-100-38" Quantity="1.54"/>   — труд рабочих по разряду, чел.-ч
 *                 <Resource Code="1" Quantity="1.54"/>          — итого труд рабочих, чел.-ч
 *                 <Resource Code="2" Quantity="6.4"/>           — труд машинистов, чел.-ч
 *                 <Resource Code="91.01.01-035" …/>             — машина, маш.-ч (цены в расценке уже учтены)
 *                 <AbstractResource Code="08.3.05.02" Quantity="П"/> — материал по проекту, в цену НЕ входит
 *               </Resources>
 *               <NrSp><ReasonItem Nr="812/пр-001.1" Sp="774/пр-001.1"/></NrSp>
 *               <Prices>
 *                 <Price Cost="2968.03" SalaryMach="87.84" Salary="14.48" Machines="2953.55" Materials="0">
 *
 * Что значат четыре числа цены, проверено на каждой из 52 тысяч расценок (тест сверяет формулу):
 * `Cost = Salary + Machines + Materials`. `Salary` — оплата труда рабочих (ОЗП), `Machines` —
 * эксплуатация машин (ЭМ) вместе с оплатой машинистов, `SalaryMach` — оплата труда машинистов
 * (ЗПМ), она уже внутри `Machines`; в фонд оплаты труда (основу НР и СП) идут ОЗП + ЗПМ.
 *
 * Расценки без `<Price>` бывают (две в «ФЕРр»): у них нет базисной стоимости, и они в выход не попадают.
 *
 * Модуль чистый: без файлов и сети, данные подаются токенами `XmlTokenizer`.
 */

export type FerBook = "ФЕР" | "ФЕРм" | "ФЕРр" | "ФЕРп" | "ФЕРмр";

/** Материал расценки, не включённый в её цену: «по проекту» (расход «П») или в количестве из приложения. */
export interface FerUnaccounted {
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  /** Расход на единицу расценки; null — «по проекту» (количество в выгрузке «П»). */
  readonly quantity: number | null;
}

/** Единичная расценка ФЕР-2001 в базисном уровне цен 01.01.2000. */
export interface FerRate {
  /** Код расценки без книги, как в ГЭСН: «12-12-001-13». Уникален только вместе с `book`. */
  readonly code: string;
  readonly book: FerBook;
  readonly table: string;
  /** Наименование таблицы + окончание строки — то, что видит сметчик. */
  readonly name: string;
  readonly endName: string;
  /** Единица расценки: «шт», «100 м», «1000 м3». */
  readonly unit: string;
  readonly collectionCode: string;
  readonly collectionName: string;
  /** Всего прямые затраты на единицу, ₽ (в базисном уровне). */
  readonly cost: number;
  /** ОЗП: оплата труда рабочих. */
  readonly wage: number;
  /** ЭМ: эксплуатация машин, включая оплату машинистов. */
  readonly machines: number;
  /** ЗПМ: оплата труда машинистов, уже входит в `machines`. */
  readonly machinistWage: number;
  /** М: материалы. */
  readonly materials: number;
  /** Затраты труда рабочих, чел.-ч на единицу; null — в расценке нет. */
  readonly labourHours: number | null;
  /** Затраты труда машинистов, чел.-ч на единицу; null — в расценке нет. */
  readonly machinistHours: number | null;
  /** Указатель НР: «812/пр-001.1»; в нашем справочнике он называется «Пр/812-001.1». */
  readonly overheadRef: string | null;
  readonly profitRef: string | null;
  /** Материалы, цена которых в расценку не входит. Пусто — расценка полная. */
  readonly unaccounted: readonly FerUnaccounted[];
  /** Поправка из `<Correction From=… To=… Coeff=…>`: у шести расценок «ЗПР→МР». null — обычная. */
  readonly correction: { readonly from: string; readonly to: string; readonly coeff: number } | null;
}

/** Ресурс справочника базисных цен (ФССЦ — материалы, ФСЭМ — машины). */
export interface FerResourcePrice {
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  /** Сметная цена в уровне 01.01.2000, ₽ (для машин — цена маш.-ч, включая оплату машинистов). */
  readonly cost: number;
  /** Оптовая цена материала (без транспортных расходов); у машин — нет. */
  readonly optCost: number | null;
  /** Оплата машинистов за маш.-ч, ₽ (только машины). */
  readonly salaryMach: number | null;
}

/** Сметная цена на перевозку и погрузку (ФССЦпг), 01.01.2000. */
export interface FerTransportPrice {
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly cost: number;
  readonly overheadPercent: number | null;
  readonly profitPercent: number | null;
}

function attr(attrs: XmlAttributes, name: string): string {
  return attrs[name] ?? "";
}

function decimal(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s+/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

const round = (value: number, digits = 4): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

interface Frame {
  readonly type: string;
  readonly name: string;
  readonly code: string;
}

function frameName(stack: readonly Frame[], type: string): Frame | undefined {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index];
    if (frame !== undefined && frame.type === type) return frame;
  }
  return undefined;
}

function joinName(begin: string, end: string): string {
  if (begin === "") return end;
  if (end === "") return begin;
  return `${begin} ${end}`.replace(/\s+/g, " ").trim();
}

const FER_BOOKS: readonly string[] = ["ФЕР", "ФЕРм", "ФЕРр", "ФЕРп", "ФЕРмр"];

/** Книга из имени файла или атрибута `BaseType`; чужое имя — null. */
export function ferBookOf(name: string): FerBook | null {
  return FER_BOOKS.includes(name) ? (name as FerBook) : null;
}

/**
 * Разбирает книгу ФЕР в расценки. Генератор: расценка выдаётся сразу, как закрыт `<Work>`, поэтому
 * 77-мегабайтный файл не оказывается в памяти разобранным целиком.
 */
export function* parseFerXml(tokens: Iterable<XmlToken>, fallbackBook: FerBook): Generator<FerRate> {
  const stack: Frame[] = [];
  let book: FerBook = fallbackBook;
  let nameGroupBegin = "";
  let tableCode = "";

  interface Work {
    code: string;
    endName: string;
    unit: string;
    nr: string | null;
    sp: string | null;
    labourTotal: number | null;
    labourSum: number;
    machinistTotal: number | null;
    machinistSum: number;
    unaccounted: FerUnaccounted[];
    price: { cost: number; salary: number; machines: number; salaryMach: number; materials: number } | null;
    correction: FerRate["correction"];
  }
  let work: Work | null = null;
  let inResources = false;

  for (const token of tokens) {
    if (token.kind === "open" || token.kind === "selfClose") {
      switch (token.tag) {
        case "base": {
          const declared = ferBookOf(attr(token.attrs, "BaseType"));
          if (declared !== null) book = declared;
          break;
        }
        case "Section": {
          if (token.kind === "open") {
            const frame: Frame = {
              type: attr(token.attrs, "Type"),
              name: decodeXmlEntities(attr(token.attrs, "Name")),
              code: attr(token.attrs, "Code"),
            };
            stack.push(frame);
            if (frame.type === "Таблица") tableCode = frame.code;
          }
          break;
        }
        case "NameGroup":
          nameGroupBegin = decodeXmlEntities(attr(token.attrs, "BeginName")).trim();
          break;
        case "Work":
          work = {
            code: attr(token.attrs, "Code").trim(),
            endName: decodeXmlEntities(attr(token.attrs, "EndName")).trim(),
            unit: decodeXmlEntities(attr(token.attrs, "MeasureUnit")).trim(),
            nr: null,
            sp: null,
            labourTotal: null,
            labourSum: 0,
            machinistTotal: null,
            machinistSum: 0,
            unaccounted: [],
            price: null,
            correction: null,
          };
          inResources = false;
          break;
        case "Resources":
          inResources = true;
          break;
        case "Resource":
        case "AbstractResource":
        case "ServiceResource": {
          if (work === null || !inResources) break;
          const code = attr(token.attrs, "Code").trim();
          const quantityRaw = attr(token.attrs, "Quantity").trim();
          const quantity = decimal(quantityRaw);
          if (token.tag === "Resource") {
            if (code === "1") work.labourTotal = quantity;
            else if (code === "2") work.machinistTotal = quantity;
            else if (/^[12]-100-\d+$/.test(code) && quantity !== null) work.labourSum += quantity;
            else if (/^4-100-\d+$/.test(code) && quantity !== null) work.machinistSum += quantity;
            break;
          }
          // Абстрактный и служебный ресурсы — материал, цены которому расценка не даёт.
          if (code === "") break;
          work.unaccounted.push({
            code,
            name: decodeXmlEntities(attr(token.attrs, "Name") || attr(token.attrs, "EndName")).trim(),
            unit: decodeXmlEntities(attr(token.attrs, "MeasureUnit")).trim(),
            quantity,
          });
          break;
        }
        case "ReasonItem": {
          if (work === null) break;
          const nr = attr(token.attrs, "Nr").trim();
          const sp = attr(token.attrs, "Sp").trim();
          if (nr !== "") work.nr = nr;
          if (sp !== "") work.sp = sp;
          break;
        }
        case "Price": {
          if (work === null) break;
          const cost = decimal(attr(token.attrs, "Cost"));
          if (cost === null) break;
          work.price = {
            cost,
            salary: decimal(attr(token.attrs, "Salary")) ?? 0,
            machines: decimal(attr(token.attrs, "Machines")) ?? 0,
            salaryMach: decimal(attr(token.attrs, "SalaryMach")) ?? 0,
            materials: decimal(attr(token.attrs, "Materials")) ?? 0,
          };
          break;
        }
        case "Correction": {
          if (work === null) break;
          const coeff = decimal(attr(token.attrs, "Coeff"));
          const from = attr(token.attrs, "From");
          const to = attr(token.attrs, "To");
          // «Coeff=0» без From/To — пустая заглушка выгрузки (26 771 расценка), а не поправка.
          if (coeff !== null && from !== "" && to !== "") work.correction = { from, to, coeff };
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (token.kind !== "close") continue;
    switch (token.tag) {
      case "Section": {
        stack.pop();
        tableCode = frameName(stack, "Таблица")?.code ?? "";
        break;
      }
      case "Resources":
        inResources = false;
        break;
      case "Work": {
        const finished = work;
        work = null;
        if (finished === null || finished.code === "" || finished.price === null) break;
        const collection = frameName(stack, "Сборник");
        yield {
          code: finished.code,
          book,
          table: tableCode !== "" ? tableCode : finished.code.split("-").slice(0, 3).join("-"),
          name: joinName(nameGroupBegin, finished.endName),
          endName: finished.endName,
          unit: finished.unit,
          collectionCode: collection?.code ?? "",
          collectionName: collection?.name ?? "",
          cost: finished.price.cost,
          wage: finished.price.salary,
          machines: finished.price.machines,
          machinistWage: finished.price.salaryMach,
          materials: finished.price.materials,
          labourHours: finished.labourTotal ?? (finished.labourSum > 0 ? round(finished.labourSum) : null),
          machinistHours: finished.machinistTotal ?? (finished.machinistSum > 0 ? round(finished.machinistSum) : null),
          overheadRef: finished.nr,
          profitRef: finished.sp,
          unaccounted: finished.unaccounted,
          correction: finished.correction,
        };
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Справочники ресурсов ФССЦ (материалы) и ФСЭМ (машины) в уровне 01.01.2000.
 *
 *   <Resource Code="01.1.01.01-0002" Name="…" MeasureUnit="100 пар">
 *     <Prices><Price Cost="498.00" OptCost="456.46"/></Prices>        — материал
 *   <Resource Code="91.01.01-001" …><Prices><Price Cost="332.31" SalaryMach="13.50"/> — машина
 *
 * Атрибут `Cost` внутри `<ExpendableMaterials>` — стоимость расходных материалов машины, а не цена:
 * учитываются только `<Price>`, стоящие в `<Prices>`.
 */
export function* parseFerResourcesXml(tokens: Iterable<XmlToken>): Generator<FerResourcePrice> {
  let pending: { code: string; name: string; unit: string } | null = null;
  let inPrices = false;
  for (const token of tokens) {
    if (token.kind === "open" || token.kind === "selfClose") {
      if (token.tag === "Resource") {
        pending = {
          code: attr(token.attrs, "Code").trim(),
          name: decodeXmlEntities(attr(token.attrs, "Name")).trim(),
          unit: decodeXmlEntities(attr(token.attrs, "MeasureUnit")).trim(),
        };
      } else if (token.tag === "Prices") {
        inPrices = true;
      } else if (token.tag === "Price" && inPrices && pending !== null && pending.code !== "") {
        const cost = decimal(attr(token.attrs, "Cost"));
        if (cost !== null) {
          yield {
            code: pending.code,
            name: pending.name,
            unit: pending.unit,
            cost,
            optCost: decimal(attr(token.attrs, "OptCost")),
            salaryMach: decimal(attr(token.attrs, "SalaryMach")),
          };
        }
      }
      if (token.kind === "selfClose" && token.tag === "Prices") inPrices = false;
    } else if (token.kind === "close") {
      if (token.tag === "Prices") inPrices = false;
      else if (token.tag === "Resource") pending = null;
    }
  }
}

/**
 * Сметные цены на перевозку и погрузку («ФССЦпг.xml», кодировка windows-1251):
 *   <Section Type="Таблица" Code="01-01" MeasureUnit="1 т груза"> <NameGroup BeginName="…">
 *     <Work Code="01-01-01-001" EndName="…" MeasureUnit="1 т груза">
 *       <Prices><Price Cost="45.01"/><Overhead Percent="100"/><Profit Percent="60"/>
 */
export function* parseFerTransportXml(tokens: Iterable<XmlToken>): Generator<FerTransportPrice> {
  let nameGroupBegin = "";
  let work: { code: string; endName: string; unit: string; cost: number | null; overhead: number | null; profit: number | null } | null = null;
  for (const token of tokens) {
    if (token.kind === "open" || token.kind === "selfClose") {
      switch (token.tag) {
        case "NameGroup":
          nameGroupBegin = decodeXmlEntities(attr(token.attrs, "BeginName")).trim();
          break;
        case "Work":
          work = {
            code: attr(token.attrs, "Code").trim(),
            endName: decodeXmlEntities(attr(token.attrs, "EndName")).trim(),
            unit: decodeXmlEntities(attr(token.attrs, "MeasureUnit")).trim(),
            cost: null,
            overhead: null,
            profit: null,
          };
          break;
        case "Price":
          if (work !== null) work.cost = decimal(attr(token.attrs, "Cost"));
          break;
        case "Overhead":
          if (work !== null) work.overhead = decimal(attr(token.attrs, "Percent"));
          break;
        case "Profit":
          if (work !== null) work.profit = decimal(attr(token.attrs, "Percent"));
          break;
        default:
          break;
      }
    } else if (token.kind === "close" && token.tag === "Work") {
      const finished = work;
      work = null;
      if (finished !== null && finished.code !== "" && finished.cost !== null) {
        yield {
          code: finished.code,
          name: joinName(nameGroupBegin, finished.endName),
          unit: finished.unit,
          cost: finished.cost,
          overheadPercent: finished.overhead,
          profitPercent: finished.profit,
        };
      }
    }
  }
}
