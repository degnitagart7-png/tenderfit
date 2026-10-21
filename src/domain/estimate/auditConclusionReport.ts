import type { DeepAnalysisReport, ReportBlock, ReportCell, ReportSection } from "@/domain/deepAnalysisReport";
import { buildAuditConclusion, DISCLAIMER, type AuditConclusion } from "@/domain/estimate/auditConclusion";
import { buildAuditOverall } from "@/domain/estimate/auditOverall";
import type { AuditReport } from "@/domain/estimate/customerAudit";
import { formatPercent, formatRub, formatSignedPercent, uncheckedLine } from "@/domain/estimate/customerAuditText";

/**
 * Структура Word-заключения по смете заказчика — отдельно от вёрстки файла.
 *
 * Содержание строится из `AuditConclusion` (то же значение показывает экран), поэтому тексты и числа в файле и на экране
 * совпадают дословно. Вёрстка в .docx — `renderReportDocx` (общая с отчётом глубокого анализа); здесь только разделы, таблицы
 * и тона, чтобы порядок и состав проверялись тестом без распаковки файла.
 *
 * Порядок — порядок вопросов читателя: что вывод → из чего он вырос → на каких позициях → чего мы не знаем → как считали.
 */

export interface AuditConclusionMeta {
  /** Объект (название расчёта или предмет закупки); null — не указан. */
  readonly subject: string | null;
  /** Номер закупки, если проверка идёт по закупке; null — смета загружена файлом. */
  readonly tenderId: string | null;
  /** Файлы, из которых прочитана смета. */
  readonly fileNames: readonly string[];
  readonly generatedAt: Date;
}

export const CONCLUSION_TITLE = "Заключение по смете заказчика";

/** Имя файла: по нему видно смету и день заключения, без открытия. */
export function auditConclusionFileName(estimateName: string, generatedAt: Date): string {
  // Символы, запрещённые в именах файлов Windows, иначе браузер сохранит файл под обрезанным именем или не сохранит вовсе.
  const safe = estimateName.replace(/[\\/:"*?<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `Заключение по смете${safe === "" ? "" : ` ${safe}`} от ${generatedAt.toISOString().slice(0, 10)}.docx`;
}

const VERDICT_TONE = { UNDERSTATED: "bad", OVERSTATED: "good", WITHIN: "neutral" } as const;

/** «21.10.2026» по Москве: дата заключения не зависит от часового пояса сервера, где собран файл. */
export function conclusionDate(date: Date): string {
  return date.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric" });
}

const cell = (text: string, extra: Partial<ReportCell> = {}): ReportCell => ({ text, ...extra });
const signedTone = (amount: number): ReportCell["tone"] => (amount > 0 ? "bad" : amount < 0 ? "good" : undefined);

/** Подпись составляющей: текст строки до первого двоеточия («Труд (с НР и СП на него): +… ₽ (3 строки)» → «Труд (с НР и СП на него)»). */
function labelOf(text: string): string {
  const at = text.indexOf(": ");
  return at < 0 ? text : text.slice(0, at);
}

export function buildAuditConclusionReport(
  conclusion: AuditConclusion,
  report: AuditReport,
  meta: AuditConclusionMeta,
): DeepAnalysisReport {
  const sections: ReportSection[] = [];

  // ---- 1. Вывод ----
  // Ответ — в первые секунды: крупная жирная строка вывода и три числа в одну строку таблицы.
  const diffText =
    conclusion.diffPercent === null
      ? formatRub(conclusion.diff, true)
      : `${formatRub(conclusion.diff, true)} (${formatSignedPercent(conclusion.diffPercent)})`;
  const verdictBlocks: ReportBlock[] = [
    { kind: "paragraph", text: conclusion.headline, tone: VERDICT_TONE[conclusion.verdict], bold: true, large: true },
    {
      kind: "table",
      columns: [
        { title: "Смета заказчика", width: 34 },
        { title: "Наш пересчёт", width: 33 },
        { title: "Разница", width: 33 },
      ],
      rows: [
        [
          cell(formatRub(conclusion.customerTotal), { bold: true }),
          cell(formatRub(conclusion.repricedTotal), { bold: true }),
          cell(diffText, { bold: true, tone: Math.abs(conclusion.diff) < 1 ? undefined : signedTone(conclusion.diff) }),
        ],
      ],
    },
    {
      kind: "paragraph",
      text: `Пересчёт по ${conclusion.method === "BASE_INDEX" ? "ФЕР-2020 и индексам Минстроя" : "нашим ценам и нормативам"} (${conclusion.pricesLabel}). ${
        conclusion.coverageText.charAt(0).toUpperCase() + conclusion.coverageText.slice(1)
      }.`,
      small: true,
    },
  ];
  if (conclusion.vatIncluded) {
    verdictBlocks.push({
      kind: "paragraph",
      text: `Суммы — с НДС ${String(report.vat.ourPercent)} %, как итог сметы заказчика.`,
      small: true,
    });
  }
  if (conclusion.coverageLow) {
    verdictBlocks.push({
      kind: "paragraph",
      text: `${conclusion.coverageText} — вывод неполный: остальное нечем переоценить.`,
      tone: "warn",
    });
  }
  if (conclusion.reasons.length > 0) {
    verdictBlocks.push(
      { kind: "paragraph", text: `Главные причины разницы (${String(conclusion.reasons.length)}):`, bold: true },
      { kind: "bullets", items: conclusion.reasons.map((line) => line.text) },
    );
  } else {
    verdictBlocks.push({ kind: "paragraph", text: "Расхождений по ценам, нормативам и арифметике не найдено." });
  }
  sections.push({ title: "Вывод", blocks: verdictBlocks });

  // ---- 2. Разница по составляющим ----
  const breakdownBlocks: ReportBlock[] = [];
  const amounted = conclusion.breakdown.filter((line) => line.amount !== null);
  if (amounted.length > 0) {
    breakdownBlocks.push({
      kind: "table",
      columns: [
        { title: "Составляющая", width: 70 },
        { title: "Влияние на итог", width: 30 },
      ],
      rows: amounted.map((line) => [
        cell(labelOf(line.text), line.text.includes(" (") ? { note: line.text.slice(line.text.lastIndexOf(" (") + 1) } : {}),
        cell(formatRub(line.amount ?? 0, true), { tone: signedTone(line.amount ?? 0) }),
      ]),
    });
    breakdownBlocks.push({
      kind: "paragraph",
      text: "Плюс — у нас дороже (смета заказчика занижена), минус — дешевле (завышена). Составляющие складываются в разницу итога.",
      small: true,
    });
  } else {
    breakdownBlocks.push({ kind: "paragraph", text: "Расхождений по составляющим не найдено." });
  }
  for (const line of conclusion.breakdown.filter((item) => item.amount === null)) {
    breakdownBlocks.push({ kind: "paragraph", text: line.text, tone: "warn" });
  }
  sections.push({ title: "Разница по составляющим", blocks: breakdownBlocks });

  // ---- 3. Позиции ----
  const positionBlocks: ReportBlock[] =
    conclusion.topPositions.length === 0
      ? [{ kind: "paragraph", text: "Расхождений по позициям нет." }]
      : [
          {
            kind: "paragraph",
            text: `Позиции с наибольшей разницей по модулю (${String(conclusion.topPositions.length)}); показаны только существенные расхождения, суммы позиций — без НДС.`,
            small: true,
          },
          {
            kind: "table",
            columns: [
              { title: "№", width: 5 },
              { title: "Шифр", width: 13 },
              { title: "Наименование", width: 24 },
              { title: "Объём", width: 9 },
              { title: "Заказчик, ₽", width: 11 },
              { title: "Наш пересчёт, ₽", width: 11 },
              { title: "Разница, ₽", width: 11 },
              { title: "Причина", width: 16 },
            ],
            rows: conclusion.topPositions.map((position) => [
              cell(String(position.number)),
              cell(position.code === "" ? "—" : position.code),
              cell(position.name.length > 110 ? `${position.name.slice(0, 110)}…` : position.name),
              cell(position.quantity === null ? "—" : `${position.quantity.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} ${position.unit}`.trim()),
              cell(formatRub(position.customerTotal)),
              cell(formatRub(position.ourTotal)),
              cell(formatRub(position.diff, true), { bold: true, tone: signedTone(position.diff) }),
              cell(position.reason === "" ? "—" : position.reason),
            ]),
          },
        ];
  sections.push({ title: "Позиции с наибольшей разницей", blocks: positionBlocks });

  // ---- 4. Не переоценено ----
  const un = conclusion.unrepriced;
  const uncheckedBlocks: ReportBlock[] = [];
  // Строки без стоимости у заказчика (0 ₽) на вывод не влияют: перечислять их — шум, на смете лыжной базы
  // (20.10.2026) раздел состоял из восьми строк «… у заказчика 0 ₽».
  const reasonsWithMoney = un.byReason.filter((item) => item.amount >= 1);
  const uncheckedWithMoney = report.unchecked.filter((item) => item.amount >= 1);
  if (un.positions === 0 && reasonsWithMoney.length === 0 && uncheckedWithMoney.length === 0) {
    uncheckedBlocks.push({
      kind: "paragraph",
      text:
        "Все позиции сметы переоценены нашими ценами и нормативами" +
        (un.partial > 0 ? `; у ${String(un.partial)} поз. не переоценены отдельные строки без стоимости — на итог они не влияют.` : "."),
    });
  } else {
    uncheckedBlocks.push({
      kind: "paragraph",
      text:
        `Не удалось переоценить: ${String(un.positions)} поз. на ${formatRub(un.amount)} у заказчика` +
        `${un.share === null ? "" : ` (${formatPercent(un.share * 100)} суммы позиций)`}` +
        `${un.partial > 0 ? `; ещё ${String(un.partial)} поз. переоценены частично` : ""}. Эти деньги остаются в пересчёте по цене заказчика — разницу по ним мы не знаем.`,
      tone: un.share !== null && un.share >= 0.3 ? "warn" : undefined,
    });
    if (reasonsWithMoney.length > 0) {
      uncheckedBlocks.push(
        { kind: "paragraph", text: "Почему не переоценено:", bold: true },
        {
          kind: "bullets",
          items: reasonsWithMoney.map((item) => `${item.label}: ${String(item.rows)} стр., у заказчика ${formatRub(item.amount)}`),
        },
      );
    }
    if (uncheckedWithMoney.length > 0) {
      uncheckedBlocks.push(
        { kind: "paragraph", text: "Крупнейшие непроверенные строки:", bold: true },
        { kind: "bullets", items: uncheckedWithMoney.slice(0, 15).map((item) => uncheckedLine(item)) },
      );
    }
  }
  sections.push({ title: "Что не удалось переоценить", blocks: uncheckedBlocks });

  // ---- 5. Методика ----
  const methodBlocks: ReportBlock[] = [
    {
      kind: "bullets",
      items: [
        "Смета заказчика читается программой построчно: объёмы, расход ресурсов, нормативы НР и СП и итоги берутся из неё как есть.",
        conclusion.method === "BASE_INDEX"
          ? "Базисные цены расценок сверяются с ФЕР-2020, индексы пересчёта — с письмом Минстроя России для субъекта, объекта строительства и квартала цен."
          : "Каждый ресурс оценивается текущей сметной ценой ФГИС ЦС выбранной ценовой зоны и квартала; труд — по тарифной шкале зоны; НР и СП — по приказам 812/пр и 774/пр.",
        "Разница раскладывается по составляющим (цены труда, машин, материалов, нормативы, арифметика, НДС) и по позициям; суммы составляющих сходятся с разницей итога.",
        "ИИ в проверке не участвует: каждую цифру можно перепроверить по смете и справочникам цен.",
      ],
    },
  ];
  sections.push({ title: "Методика", blocks: methodBlocks });

  // ---- 6. Оговорки ----
  sections.push({
    title: "Оговорки",
    blocks: [
      { kind: "bullets", items: [...conclusion.caveats] },
      { kind: "paragraph", text: DISCLAIMER, bold: true },
    ],
  });

  const files = meta.fileNames.length > 0 ? meta.fileNames.join(", ") : report.documentName;
  const facts: [string, string][] = [
    ["Объект", meta.subject !== null && meta.subject.trim() !== "" ? meta.subject.trim() : "не указан"],
    ["Закупка", meta.tenderId === null ? "смета загружена файлом" : `№ ${meta.tenderId}`],
    ["Проверенный файл", files],
    ["Смета", conclusion.title],
    ["Дата заключения", conclusionDate(meta.generatedAt)],
    ["Цены сравнения", conclusion.pricesLabel],
    ["Метод сметы", conclusion.method === "BASE_INDEX" ? "базисно-индексный (ФЕР/ТЕР-2001 × индексы Минстроя)" : "ресурсно-индексный (форма 421/пр, ФСНБ-2022)"],
  ];

  return {
    title: CONCLUSION_TITLE,
    regNumber: meta.tenderId ?? "—",
    subject: conclusion.title,
    facts,
    sections,
  };
}

/* ====================== Заключение по всем сметам закупки ====================== */

/** Имя файла общего заключения. */
export function auditOverallFileName(generatedAt: Date): string {
  return `Заключение по всем сметам от ${generatedAt.toISOString().slice(0, 10)}.docx`;
}

export const OVERALL_TITLE = "Заключение по всем сметам заказчика";

/**
 * Общее заключение: итог по всем сметам, таблица «каждая смета одной строкой», затем по сметам. У сметы с расхождениями — причины
 * и таблица позиций; у остальных — одна строка. Строится из тех же `AuditConclusion`, что и заключение по одной смете.
 */
export function buildAuditOverallReport(
  reports: readonly AuditReport[],
  meta: AuditConclusionMeta,
  notRecognizedLines: readonly string[] = [],
): DeepAnalysisReport {
  const overall = buildAuditOverall(reports);
  const conclusions = reports.map((report) => buildAuditConclusion({ report }));
  const sections: ReportSection[] = [];

  const diffText =
    overall.diffPercent === null ? formatRub(overall.diff, true) : `${formatRub(overall.diff, true)} (${formatSignedPercent(overall.diffPercent)})`;
  const summary: ReportBlock[] = [
    { kind: "paragraph", text: overall.headline, tone: VERDICT_TONE[overall.verdict], bold: true, large: true },
    {
      kind: "table",
      columns: [
        { title: "Сметы заказчика", width: 34 },
        { title: "Наш пересчёт", width: 33 },
        { title: "Разница", width: 33 },
      ],
      rows: [
        [
          cell(formatRub(overall.customerTotal), { bold: true }),
          cell(formatRub(overall.repricedTotal), { bold: true }),
          cell(diffText, { bold: true, tone: Math.abs(overall.diff) < 1 ? undefined : signedTone(overall.diff) }),
        ],
      ],
    },
    {
      kind: "paragraph",
      text: `${overall.coverageText.charAt(0).toUpperCase() + overall.coverageText.slice(1)}${
        overall.unrepricedPositions > 0 ? ` · не переоценено целиком ${String(overall.unrepricedPositions)} поз.` : ""
      }. Цены сравнения: ${overall.pricesLabel}.${overall.vatNormalized ? " Суммы приведены к НДС: в наборе есть сметы с НДС и без него." : ""}`,
      small: true,
      tone: overall.coverageLow ? "warn" : undefined,
    },
    {
      kind: "table",
      columns: [
        { title: "Смета", width: 27 },
        { title: "Заказчик, ₽", width: 14 },
        { title: "Пересчёт, ₽", width: 14 },
        { title: "Разница, ₽ (%)", width: 17 },
        { title: "Проверено", width: 10 },
        { title: "Вывод", width: 18 },
      ],
      rows: overall.rows.map((row) => [
        cell(row.title, row.subtitle === "" ? {} : { note: row.subtitle }),
        cell(formatRub(row.customerTotal)),
        cell(formatRub(row.repricedTotal)),
        cell(
          row.diffPercent === null ? formatRub(row.diff, true) : `${formatRub(row.diff, true)} (${formatSignedPercent(row.diffPercent)})`,
          { bold: row.attention, tone: Math.abs(row.diff) < 1 ? undefined : signedTone(row.diff) },
        ),
        cell(`${String(Math.round(row.coverage * 100))} %`, row.coverage < 0.7 ? { tone: "warn" } : {}),
        cell(row.verdictText, row.attention ? { tone: row.verdict === "OVERSTATED" ? "good" : row.verdict === "UNDERSTATED" ? "bad" : "warn" } : {}),
      ]),
    },
  ];
  sections.push({ title: `Итого по всем сметам (${String(reports.length)})`, blocks: summary });

  reports.forEach((report, index) => {
    const conclusion = conclusions[index] as AuditConclusion;
    const row = overall.rows[index]!;
    const blocks: ReportBlock[] = [
      { kind: "paragraph", text: conclusion.headline, tone: VERDICT_TONE[conclusion.verdict], bold: true },
      {
        kind: "paragraph",
        text: `Заказчик ${formatRub(conclusion.customerTotal)} → пересчёт ${formatRub(conclusion.repricedTotal)}; ${conclusion.coverageText}.${
          row.subtitle === "" ? "" : ` ${row.subtitle}.`
        }`,
        small: true,
      },
    ];
    if (!row.attention && conclusion.topPositions.length === 0) {
      blocks.push({ kind: "paragraph", text: "Расхождений нет." });
    } else {
      if (conclusion.reasons.length > 0) blocks.push({ kind: "bullets", items: conclusion.reasons.map((line) => line.text) });
      if (conclusion.topPositions.length > 0 && row.attention) {
        blocks.push({
          kind: "table",
          columns: [
            { title: "№", width: 5 },
            { title: "Шифр", width: 14 },
            { title: "Наименование", width: 30 },
            { title: "Заказчик, ₽", width: 12 },
            { title: "Наш, ₽", width: 12 },
            { title: "Разница, ₽", width: 12 },
            { title: "Причина", width: 15 },
          ],
          rows: conclusion.topPositions.slice(0, 20).map((position) => [
            cell(String(position.number)),
            cell(position.code === "" ? "—" : position.code),
            cell(position.name.length > 90 ? `${position.name.slice(0, 90)}…` : position.name),
            cell(formatRub(position.customerTotal)),
            cell(formatRub(position.ourTotal)),
            cell(formatRub(position.diff, true), { bold: true, tone: signedTone(position.diff) }),
            cell(position.reason === "" ? "—" : position.reason),
          ]),
        });
      }
      const un = conclusion.unrepriced;
      if (un.positions > 0) {
        blocks.push({
          kind: "paragraph",
          text: `Не удалось переоценить: ${String(un.positions)} поз. на ${formatRub(un.amount)} у заказчика; причины: ${un.byReason.map((item) => item.label).join("; ")}.`,
          small: true,
          tone: "warn",
        });
      }
    }
    sections.push({ title: row.title, blocks });
  });

  sections.push({
    title: "Методика",
    blocks: [
      {
        kind: "bullets",
        items: [
          "Сметы заказчика читаются программой построчно: объёмы, расход ресурсов, нормативы НР и СП и итоги берутся из них как есть.",
          "Ресурсы оценены текущими сметными ценами ФГИС ЦС зоны и квартала проверки (смета БИМ — ФЕР-2020 и индексы Минстроя); НР и СП — по приказам 812/пр и 774/пр.",
          "Итог по всем сметам — сумма по сметам; покрытие взвешено по прямым затратам. «Занижена» и «завышена» — разница больше 5 % итога сметы.",
          "ИИ в проверке не участвует: каждую цифру можно перепроверить по смете и справочникам цен.",
        ],
      },
    ],
  });
  sections.push({
    title: "Оговорки",
    blocks: [
      { kind: "bullets", items: [conclusions[0]?.caveats[0] ?? "", ...notRecognizedLines].filter((line) => line !== "") },
      { kind: "paragraph", text: DISCLAIMER, bold: true },
    ],
  });

  const files = meta.fileNames.length > 0 ? meta.fileNames.join(", ") : [...new Set(reports.map((report) => report.documentName))].join(", ");
  return {
    title: OVERALL_TITLE,
    regNumber: meta.tenderId ?? "—",
    subject: `Смет: ${String(reports.length)}`,
    facts: [
      ["Объект", meta.subject !== null && meta.subject.trim() !== "" ? meta.subject.trim() : "не указан"],
      ["Закупка", meta.tenderId === null ? "сметы загружены файлами" : `№ ${meta.tenderId}`],
      ["Проверенные файлы", files],
      ["Смет в заключении", String(reports.length)],
      ["Дата заключения", conclusionDate(meta.generatedAt)],
      ["Цены сравнения", overall.pricesLabel],
    ],
    sections,
  };
}
