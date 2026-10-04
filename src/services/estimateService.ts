import { buildEstimate } from "@/domain/estimate/calculate";
import { findNorms } from "@/domain/estimate/matchNorms";
import { priceLevelMismatch } from "@/domain/estimate/priceLevel";
import { deriveUnitDivisor } from "@/domain/estimate/billExtraction";
import type {
  BillOfWorkItem,
  BillOfWorkSection,
  EstimateDocument,
  EstimateParameters,
} from "@/domain/estimate/types";
import type { RejectedBillRow } from "@/domain/estimate/billExtraction";
import {
  extractBillOfWork,
  remoteBillRows,
  type BillDocumentInput,
  type BillRowsFetcher,
} from "@/services/billOfWorkExtraction";
import {
  loadEstimateBase,
  type EstimateBase,
} from "@/repositories/estimateBaseRepository";

/**
 * Сборка сметы по документации: от текста документов до готового документа.
 *
 * Здесь сходятся три части, каждая из которых уже есть по отдельности: разбор
 * ведомости моделью, подбор норм по ФСНБ и детерминированный расчёт. Сервис не
 * добавляет к ним арифметики — он только связывает их и честно сообщает, что
 * потерялось по дороге.
 *
 * Почему это не идёт в браузер и не пойдёт на Vercel. База ФСНБ — 56 242 нормы
 * и справочники цен, она занимает около 600 МБ памяти и читается с диска за две
 * секунды. В поставку она не входит намеренно, поэтому расчёт живёт там, где
 * лежит каталог индекса: на машине разработчика и на сервере воркера. Если
 * базы нет, сервис не делает вид, что посчитал, а возвращает причину и команду
 * сборки.
 *
 * Делитель единиц назначается здесь, а не при извлечении ведомости: он зависит
 * от единицы найденной нормы («м3» в ведомости против «100 м3» в расценке), а
 * норма известна только после подбора.
 */

export interface EstimateRequestInput {
  readonly regNumber: string;
  readonly subject: string;
  readonly documents: readonly BillDocumentInput[];
  /** Параметры расчёта: НДС, резервные нормативы, лимитированные затраты. */
  readonly parameters: EstimateParameters;
  readonly now?: Date;
}

export interface EstimateBuildResult {
  readonly document: EstimateDocument;
  /** Строки, не подтверждённые документом: показываются пользователю. */
  readonly rejected: readonly RejectedBillRow[];
  readonly documentsWithoutBill: readonly string[];
  readonly billItems: number;
  readonly tokensUsed: number;
}

/** База не собрана: расчёт невозможен, и это надо сказать словами. */
export class EstimateBaseMissingError extends Error {
  constructor(
    message: string,
    readonly indexDir: string,
    readonly command: string,
  ) {
    super(message);
    this.name = "EstimateBaseMissingError";
  }
}

/**
 * Документ посчитан в другом уровне цен, чем собранный индекс.
 *
 * Отдельная ошибка, а не пометка в смете: пометку читают после того, как
 * деньги посчитаны, а смета не в том уровне цен выглядит ровно как смета в
 * том. На живом прогоне 02-01-02-КМ1 сметчик считал по 2 зоне за 1 квартал
 * 2026, индекс нёс 1 зону за 3 квартал 2026, и сравнение итогов не значило
 * ничего — расходились цены каждого ресурса.
 */
export class EstimatePriceLevelError extends Error {
  constructor(
    message: string,
    readonly documentName: string,
  ) {
    super(message);
    this.name = "EstimatePriceLevelError";
  }
}

/**
 * Назначает делитель единицы по норме, которую подобрал поиск.
 *
 * Единицы не сошлись — делитель остаётся единицей, а расчёт пометит позицию
 * расхождением. Подставлять догадку нельзя: «м2» и «т» переводятся друг в
 * друга только через плотность, которой в ведомости нет.
 */
function withUnitDivisor(
  item: BillOfWorkItem,
  base: EstimateBase,
): BillOfWorkItem {
  const found = findNorms(base.searchIndex, {
    workName: item.workName,
    normCode: item.normCode,
    normBaseType: item.normBaseType,
    limit: 1,
  });
  const norm = found[0]?.norm;
  if (norm === undefined) return item;

  const divisor = deriveUnitDivisor(item.quantityUnit, norm.unit);
  if (divisor === null || divisor <= 0) return item;

  return { ...item, unitDivisor: divisor };
}

/**
 * Чем можно подменить окружение расчёта.
 *
 * База и вызов модели вынесены в зависимости не ради гибкости, а ради
 * проверяемости: настоящая база читается с диска две секунды и занимает 600 МБ,
 * а вызов модели стоит денег. Тест подставляет и то и другое.
 */
export interface EstimateDeps {
  readonly fetcher?: BillRowsFetcher;
  readonly base?: EstimateBase;
}

/**
 * Как расчёт зовёт модель на сервере воркера.
 *
 * Через приложение по адресу `SYNC_BASE_URL` — тот же, каким воркер
 * пользуется для глубокого разбора. Раньше здесь было написано, что ключ
 * модели живёт только на Vercel; это перестало быть правдой после переезда:
 * `LLM_API_KEY` лежит в `/etc/tenderfit/app.env` рядом с приложением.
 *
 * Адрес важен не только ради лишнего прыжка за рубеж. Промпт извлечения
 * ведомости живёт в роуте `/api/estimate/bill-rows`, то есть в приложении: на
 * какой адрес смотрит воркер, тем разбором смета и считается. Пока
 * `SYNC_BASE_URL` указывает на Vercel, правки промпта в этом дереве на смету
 * не влияют — см. deploy/README.md.
 */
export function workerBillFetcher(baseUrl: string): BillRowsFetcher {
  return remoteBillRows(baseUrl);
}

export async function buildEstimateFromDocuments(
  input: EstimateRequestInput,
  deps: EstimateDeps = {},
): Promise<EstimateBuildResult> {
  let base: EstimateBase;
  if (deps.base !== undefined) {
    base = deps.base;
  } else {
    try {
      base = await loadEstimateBase();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new EstimateBaseMissingError(
        reason,
        "data/fsnb/index",
        "npx tsx scripts/fsnb/build-index.ts",
      );
    }
  }

  /*
    Сверка уровня цен идёт до вызова модели. Считать в чужом уровне всё равно
    нельзя, а извлечение ведомости стоит токенов: на живом прогоне их ушло
    12 369 за один документ.

    Документ, который об уровне цен не говорит, проходит дальше: большая часть
    документации закупки его не печатает, и отказывать по этому поводу значило
    бы закрыть расчёт для всех, кого сверять не с чем.
  */
  for (const document of input.documents) {
    const mismatch = priceLevelMismatch(document.text, {
      priceZone: base.priceBook.priceZone,
      period: base.priceBook.period,
    });
    if (mismatch !== null) {
      throw new EstimatePriceLevelError(
        `${document.name}: ${mismatch}`,
        document.name,
      );
    }
  }

  const extraction = await extractBillOfWork(
    input.documents,
    { regNumber: input.regNumber, subject: input.subject },
    deps.fetcher,
  );

  const sections: BillOfWorkSection[] = extraction.sections.map((section) => ({
    title: section.title,
    items: section.items.map((item) => withUnitDivisor(item, base)),
  }));

  const billItems = sections.reduce(
    (sum, section) => sum + section.items.length,
    0,
  );

  const generatedAt = (input.now ?? new Date()).toISOString();
  const document = buildEstimate({
    title: input.subject,
    sections,
    priceBook: base.priceBook,
    parameters: input.parameters,
    resolveNorm: (item) => {
      const found = findNorms(base.searchIndex, {
        workName: item.workName,
        normCode: item.normCode,
        normBaseType: item.normBaseType,
        limit: 1,
      });
      const first = found[0];
      return first === undefined
        ? null
        : { norm: first.norm, reasons: first.reasons };
    },
    sources: base.sources,
    generatedAt,
    disclaimer: ESTIMATE_DISCLAIMER,
  });

  return {
    document,
    rejected: extraction.rejected,
    documentsWithoutBill: extraction.documentsWithoutBill,
    billItems,
    tokensUsed: extraction.tokensUsed,
  };
}

/**
 * Оговорка внутри документа.
 *
 * Файл уходит из интерфейса и живёт дальше сам: его перешлют, приложат к
 * письму, распечатают. Оговорка, оставшаяся на экране, до читателя такого файла
 * не доедет, а решение по ней принимают.
 */
export const ESTIMATE_DISCLAIMER =
  "Расчёт носит информационно-аналитический характер и не является сметной " +
  "документацией. Объёмы работ извлечены из документации закупки автоматически " +
  "и требуют проверки. Стоимость определена ресурсно-индексным методом по " +
  "открытым данным ФГИС ЦС. Для экспертизы и договора смету составляет и " +
  "подписывает аттестованный сметчик.";
