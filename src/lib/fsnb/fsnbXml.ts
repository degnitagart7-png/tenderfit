import { roundTo, toNormResource } from "@/domain/estimate/resourceKinds";
import type { NormRecord, NormResource, ResourcePrice } from "@/domain/estimate/types";
import { decodeXmlEntities, type XmlAttributes, type XmlToken } from "@/lib/fsnb/xmlTokenizer";

/**
 * Разбор выгрузок ФСНБ-2022 в доменные записи.
 *
 * Структура файлов проверена на реальной выгрузке редакции от 12.08.2026
 * (приказ Минстроя России № 527/пр), а не взята из описания:
 *
 * «ГЭСН.xml» и остальные книги норм:
 *   <base BaseType="ГЭСН" PriceLevel="01.01.2022">
 *     <ResourcesDirectory><ResourceCategory CodePrefix="ГЭСН">
 *       <Section Type="Сборник" Code="01" Name="Земляные работы">
 *         <Section Type="Раздел" ...><Section Type="Подраздел" ...>
 *           <Section Type="Таблица" Code="01-01-001" Name="...">
 *             <NameGroup BeginName="Разработка грунта ... с ковшом вместимостью:">
 *               <Work Code="01-01-001-01" EndName="15 м3, группа грунтов 1" MeasureUnit="1000 м3">
 *                 <Content><Item Text="..."/></Content>
 *                 <Resources><Resource Code="91.01.01-035" EndName="..." Quantity="1.6"/></Resources>
 *                 <NrSp><ReasonItem Nr="Пр/812-001.1" Sp="Пр/774-001.1"/></NrSp>
 *
 * Порядок атрибутов в выгрузке не фиксирован: рядом с нормой 01-01-111 таблица
 * записана как `<Section Name="..." Type="Таблица" Code="01-01-111">`, поэтому
 * атрибуты читаются по именам, а не по позиции.
 *
 * Кроме `<Resource>` в блоке Resources встречаются ещё два элемента, и оба
 * несут стоимость, которую норма не определяет:
 *   <AbstractResource Code="01.7.12.16" Name="Сетка геотехническая ..."
 *                     Quantity="1428.3" TechnologyGroups="54.08.005"/> — 35 039
 *     в «ГЭСН.xml»: код группы без конкретной марки;
 *   <ServiceResource Code="999-9901" Category="Материал"
 *                     Name="МАТЕРИАЛЫ (см. приложение)" Quantity="П"/> — 233:
 *     неучтённые расценкой материалы из приложения.
 * Оба разбираются в ресурсы с признаком `projectSpecific`, чтобы расчёт показал
 * их как пробел, а не потерял молча.
 *
 * «ФСБЦ_Мат&Оборуд.xml» и «ФСБЦ_Маш.xml»:
 *   <ResourceCatalog><ResourcesDirectory><ResourceCategory Type="Материал">
 *     <Section Type="Книга|Часть|Раздел|Группа" ...>
 *       <Resource Code="01.1.01.01-0002" Name="..." MeasureUnit="100 компл">
 *         <Prices><Price Cost="35537.67" OptCost="34458.33"/></Prices>
 * машины дополнительно: SalaryMach, LabourMach, PriceCostWithoutSalary.
 */

/**
 * Разобранный ресурс справочника цен.
 *
 * Реквизиты приказа лежат рядом, а не в поле `price.period`: период — это
 * квартал текущих цен ФСЦСР, а у базы 01.01.2022 квартала нет. Подставлять
 * туда номер приказа значило бы показать пользователю «3 квартал» там, где
 * его не существует.
 */
export interface CatalogResource {
  readonly price: ResourcePrice;
  /** Номер утверждающего приказа, например «527/пр». */
  readonly approvingAct: string | null;
}

interface SectionFrame {
  readonly type: string;
  readonly name: string;
  readonly code: string;
}

/** Числа в выгрузке идут с точкой, но запятую на всякий случай тоже принимаем. */
export function parseDecimal(raw: string | undefined | null, fallback = 0): number {
  if (raw === undefined || raw === null) return fallback;
  const cleaned = raw.trim().replace(/\s+/g, "").replace(",", ".");
  if (cleaned.length === 0) return fallback;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Количество ресурса с сохранением пометки.
 *
 * В выгрузке количество бывает не числом: «П» означает «по проекту» и
 * встречается в «ГЭСН.xml» 15 437 раз. Терять такую пометку нельзя — иначе
 * позиция без расхода выглядит как посчитанная с нулевым расходом.
 */
export function parseQuantity(raw: string): { value: number; note: string | null } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: 0, note: null };
  const value = parseDecimal(trimmed, Number.NaN);
  if (Number.isFinite(value)) return { value, note: null };
  return { value: 0, note: trimmed };
}

function attr(attrs: XmlAttributes, name: string): string {
  return attrs[name] ?? "";
}

/**
 * Разбирает поток токенов книги норм в записи NormRecord.
 * Генератор: норма выдаётся сразу, как только закрыт элемент Work, поэтому
 * файл в 84 МБ не оказывается в памяти целиком.
 */
export function* parseNormsXml(
  tokens: Iterable<XmlToken>,
  fallbackBaseType: string,
): Generator<NormRecord> {
  const sectionStack: SectionFrame[] = [];
  let baseType = fallbackBaseType;
  let nameGroupBegin = "";
  let tableCode = "";

  let work: { code: string; endName: string; unit: string } | null = null;
  let workContent: string[] = [];
  let workResources: NormResource[] = [];
  let workNr: string | null = null;
  let workSp: string | null = null;
  let inContent = false;
  let inResources = false;

  for (const token of tokens) {
    if (token.kind === "open" || token.kind === "selfClose") {
      switch (token.tag) {
        case "base": {
          const declared = attr(token.attrs, "BaseType");
          if (declared.length > 0) baseType = declared;
          break;
        }
        case "Section": {
          const frame: SectionFrame = {
            type: attr(token.attrs, "Type"),
            name: decodeXmlEntities(attr(token.attrs, "Name")),
            code: attr(token.attrs, "Code"),
          };
          if (token.kind === "open") {
            sectionStack.push(frame);
            if (frame.type === "Таблица") tableCode = frame.code;
          }
          break;
        }
        case "NameGroup": {
          nameGroupBegin = decodeXmlEntities(attr(token.attrs, "BeginName")).trim();
          break;
        }
        case "Work": {
          work = {
            code: attr(token.attrs, "Code").trim(),
            endName: decodeXmlEntities(attr(token.attrs, "EndName")).trim(),
            unit: decodeXmlEntities(attr(token.attrs, "MeasureUnit")).trim(),
          };
          workContent = [];
          workResources = [];
          workNr = null;
          workSp = null;
          break;
        }
        case "Content": {
          inContent = true;
          break;
        }
        case "Resources": {
          inResources = true;
          break;
        }
        case "Item": {
          if (inContent && work !== null) {
            const text = decodeXmlEntities(attr(token.attrs, "Text")).trim();
            if (text.length > 0) workContent.push(text);
          }
          break;
        }
        case "Resource":
        case "AbstractResource":
        case "ServiceResource": {
          if (!inResources || work === null) break;
          const code = attr(token.attrs, "Code").trim();
          if (code.length === 0) break;
          const measureUnit = decodeXmlEntities(attr(token.attrs, "MeasureUnit")).trim();
          const quantity = parseQuantity(attr(token.attrs, "Quantity"));
          workResources.push(
            toNormResource({
              code,
              name: decodeXmlEntities(
                attr(token.attrs, "EndName") || attr(token.attrs, "Name"),
              ),
              quantity: quantity.value,
              unit: measureUnit.length > 0 ? measureUnit : null,
              quantityNote: quantity.note,
              // Абстрактный ресурс задан кодом группы без марки, служебный —
              // ссылкой на приложение. Цены на такой код в классификаторе нет.
              projectSpecific: token.tag !== "Resource",
              technologyGroup: attr(token.attrs, "TechnologyGroups") || null,
            }),
          );
          break;
        }
        case "ReasonItem": {
          if (work !== null) {
            const nr = attr(token.attrs, "Nr").trim();
            const sp = attr(token.attrs, "Sp").trim();
            if (nr.length > 0) workNr = nr;
            if (sp.length > 0) workSp = sp;
          }
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (token.kind === "close") {
      switch (token.tag) {
        case "Section": {
          sectionStack.pop();
          tableCode = findLastCode(sectionStack, "Таблица");
          break;
        }
        case "Content": {
          inContent = false;
          break;
        }
        case "Resources": {
          inResources = false;
          break;
        }
        case "Work": {
          if (work === null) break;
          const names = pickSectionNames(sectionStack);
          const fullName = joinName(nameGroupBegin, work.endName);
          const record: NormRecord = {
            code: work.code,
            tableCode: tableCode.length > 0 ? tableCode : deriveTableCode(work.code),
            fullName,
            endName: work.endName,
            unit: work.unit,
            collectionCode: names.collectionCode,
            collectionName: names.collectionName,
            sectionName: names.sectionName,
            subsectionName: names.subsectionName,
            baseType,
            content: workContent,
            resources: workResources,
            overheadRef: workNr,
            profitRef: workSp,
          };
          work = null;
          workContent = [];
          workResources = [];
          workNr = null;
          workSp = null;
          yield record;
          break;
        }
        default:
          break;
      }
    }
  }
}

/**
 * Разбирает справочник цен ФСБЦ: материалы, оборудование и машины.
 *
 * В выгрузке цена машины разложена на две части — `PriceCostWithoutSalary` и
 * зарплата звена, поэтому полная стоимость маш.-ч собирается как
 * «без зарплаты» + `SalaryMach × LabourMach`. Проверено на реальных строках
 * «ФСБЦ_Маш.xml»: бульдозер 79 кВт (91.01.01-035) = 887.54 + 451.93 × 1.00,
 * шагающий драглайн 15 м3 (91.01.05-128) = 83 057.40 + 1 692.45 × 3.00.
 *
 * Поле `machinistSalary` отдаётся сразу умноженным на состав звена, потому что
 * по типу это ₽ за один маш.-ч, а не за человеко-час: именно эта величина входит
 * в фонд оплаты труда, а через него — в накладные расходы и сметную прибыль.
 * Отдать ставку на одного машиниста значило бы занизить ФОТ втрое на каждой
 * машине с звеном из трёх человек.
 */
export function* parsePriceCatalogXml(
  tokens: Iterable<XmlToken>,
  defaultKind: "material" | "machine",
): Generator<CatalogResource> {
  let approvingAct = "";
  let pending: { code: string; name: string; unit: string } | null = null;

  for (const token of tokens) {
    if (token.kind === "open" || token.kind === "selfClose") {
      switch (token.tag) {
        case "Resource": {
          pending = {
            code: attr(token.attrs, "Code").trim(),
            name: decodeXmlEntities(attr(token.attrs, "Name")).trim(),
            unit: decodeXmlEntities(attr(token.attrs, "MeasureUnit")).trim(),
          };
          break;
        }
        case "Price": {
          if (pending === null || pending.code.length === 0) break;
          const cost = parseDecimal(attr(token.attrs, "Cost"), Number.NaN);
          const salaryMach = parseDecimal(attr(token.attrs, "SalaryMach"), 0);
          const labourMach = parseDecimal(attr(token.attrs, "LabourMach"), 0);
          const withoutSalary = parseDecimal(attr(token.attrs, "PriceCostWithoutSalary"), Number.NaN);

          const crewSalary = roundTo(salaryMach * labourMach, 2);
          const price = Number.isFinite(cost)
            ? cost
            : Number.isFinite(withoutSalary)
              ? roundTo(withoutSalary + crewSalary, 2)
              : null;

          if (price !== null) {
            yield {
              price: {
                code: pending.code,
                name: pending.name,
                unit: pending.unit,
                price,
                machinistSalary: defaultKind === "machine" ? crewSalary : null,
                machinistHours: defaultKind === "machine" ? labourMach : null,
                source: "BASE_2022",
                period: null,
                zone: null,
              },
              approvingAct: approvingAct.length > 0 ? approvingAct : null,
            };
          }
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (token.kind === "close") {
      if (token.tag === "Resource") pending = null;
    } else if (token.kind === "text") {
      // Номер приказа лежит текстом внутри <Decrees><ApprovingActNumber>.
      if (approvingAct.length === 0 && /^\d+\/пр$/.test(token.text)) approvingAct = token.text;
    }
  }
}

function findLastCode(stack: readonly SectionFrame[], type: string): string {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index];
    if (frame !== undefined && frame.type === type) return frame.code;
  }
  return "";
}

interface SectionNames {
  collectionCode: string;
  collectionName: string;
  sectionName: string;
  subsectionName: string;
}

function pickSectionNames(stack: readonly SectionFrame[]): SectionNames {
  const byType = (type: string): SectionFrame | undefined =>
    [...stack].reverse().find((frame) => frame.type === type);

  const collection = byType("Сборник");
  return {
    collectionCode: collection?.code ?? "",
    collectionName: collection?.name ?? "",
    sectionName: byType("Раздел")?.name ?? "",
    subsectionName: byType("Подраздел")?.name ?? "",
  };
}

/** «Начало наименования: окончание» — так норма выглядит в печатной таблице. */
function joinName(begin: string, end: string): string {
  if (begin.length === 0) return end;
  if (end.length === 0) return begin;
  return `${begin} ${end}`.replace(/\s+/g, " ").trim();
}

/** Код таблицы из кода нормы: первые три группы цифр. */
function deriveTableCode(code: string): string {
  const parts = code.split("-");
  if (parts.length <= 3) return code;
  return parts.slice(0, 3).join("-");
}
