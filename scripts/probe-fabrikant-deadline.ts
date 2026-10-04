/**
 * Временный зонд: где карточка Фабриканта печатает срок приёма заявок.
 *
 * Повод — плановый прогон 03.10.2026 22:51 UTC: из 101 закупки Фабриканта 44
 * не записались с ошибкой 22007 «invalid input syntax for type timestamp with
 * time zone: ""». Значит, `fabrikantMapper` собрал `submissionEnd` пустым:
 * `earliestDeadline(lots)` возвращает "", когда панель `proposal_date_stop` не
 * нашлась ни у одного лота. Выдача при этом ограничена статусами 1 и 5 —
 * «приём заявок» и «ожидание приёма», то есть площадка считает процедуры
 * живыми, и срок у них должен быть.
 *
 * Зонд отвечает на один вопрос: срок действительно не напечатан или напечатан
 * там, где разбор его не ищет (панель уровня процедуры до первого контейнера
 * лота, другой ключ шаблона).
 *
 * Личные данные и текст документации в вывод попасть не могут: зонд печатает
 * только имена панелей, счётчики и признаки. Значения панелей не читаются
 * вовсе — кроме проверки «похоже ли на дату», и она печатается как «да/нет».
 *
 * Запуск (read-only, только GET):
 *   npx tsx scripts/probe-fabrikant-deadline.ts [ключевое слово] [предел процедур]
 *
 * После замера файл удаляется: это не часть продукта.
 */
import * as cheerio from "cheerio";
import {
  FABRIKANT_DEFAULT_SECTIONS,
  FABRIKANT_OPEN_STATUSES,
  fabrikantSearchUrl,
  parseFabrikantSearch,
} from "../src/adapters/tender-source/fabrikantSearch";
import {
  fabrikantCardPageUrl,
  fabrikantCardUrlKind,
  fabrikantDateTime,
  parseFabrikantCard,
} from "../src/adapters/tender-source/fabrikantCard";

/** Те же префиксы классов, что и в разборе карточки. */
const PANEL_PREFIX = "panel-group-element-";
const LOT_PREFIX = "lot_head_";

/** Ключ панели, в котором стоит искать срок. */
const DATEISH = /date|stop|proposal|period|srok|deadline|time/i;

/** Заголовки адаптера: зонд обязан ходить тем же запросом, что и прогон. */
const HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9",
};

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { ...HEADERS }, redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** Пауза между запросами: мы в гостях, а не на своём сервере. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Level {
  /** Имена панелей уровня процедуры — всё, что встретилось до первого лота. */
  readonly procedure: string[];
  /** Имена панелей внутри контейнеров лотов. */
  readonly lot: string[];
  /** Сколько контейнеров лота на странице. */
  readonly lotContainers: number;
}

/**
 * Обход дерева ровно как в `parseFabrikantCard`, но вместо значений — имена.
 *
 * Порядок документа решает: контейнер лота встречается раньше своих панелей,
 * поэтому всё найденное до первого контейнера — уровень процедуры.
 */
function panelLevels(html: string): Level {
  const $ = cheerio.load(html);
  const procedure: string[] = [];
  const lot: string[] = [];
  let lotContainers = 0;

  $(`[class*="${LOT_PREFIX}"], [class*="${PANEL_PREFIX}"]`).each((_index, element) => {
    const classes = ($(element).attr("class") ?? "").split(/\s+/);
    if (classes.some((one) => one.startsWith(LOT_PREFIX))) {
      lotContainers += 1;
      return;
    }
    const panelClass = classes.find((one) => one.startsWith(PANEL_PREFIX));
    if (panelClass === undefined) return;
    const key = panelClass.slice(PANEL_PREFIX.length);
    if (lotContainers === 0) procedure.push(key);
    else lot.push(key);
  });

  return { procedure, lot, lotContainers };
}

/**
 * Что площадка напечатала в панели: сколько в ней дат и какая читается первой.
 *
 * Значение панели не печатается — только число найденных дат и результат
 * разбора. Число важнее текста: `fabrikantDateTime` берёт ПЕРВУЮ дату, и если
 * панель печатает диапазон «01.10.2026 10:00 — 05.10.2026 18:00», первой будет
 * дата начала приёма, а не его окончания. Такой срок публиковать нельзя.
 */
function panelDateShape(html: string, key: string): { dates: number; parsed: string } {
  const $ = cheerio.load(html);
  let text = "";
  $(`[class*="${PANEL_PREFIX}${key}"] .col-md-8`)
    .first()
    .each((_index, element) => {
      text = $(element).text() ?? "";
    });
  const dates = (text.match(/\d{2}\.\d{2}\.\d{4}/g) ?? []).length;
  return { dates, parsed: fabrikantDateTime(text) };
}

async function main(): Promise<void> {
  const keyword = process.argv[2] ?? "строительство";
  const wanted = Number.parseInt(process.argv[3] ?? "12", 10);
  if (!Number.isFinite(wanted) || wanted < 1) throw new Error("Предел процедур — число от 1");

  console.log("Зонд Фабриканта: где карточка печатает срок приёма заявок");
  console.log(`Ключевое слово: «${keyword}», процедур осмотреть: ${wanted}`);
  console.log();

  const searchUrl = fabrikantSearchUrl({
    query: keyword,
    sections: FABRIKANT_DEFAULT_SECTIONS,
    statuses: FABRIKANT_OPEN_STATUSES,
    page: 1,
  });
  const page = parseFabrikantSearch(await fetchText(searchUrl));
  console.log(
    `Выдача: строк ${page.rows.length}, всего ${page.total ?? "?"}, страниц ${page.pages ?? "?"}`,
  );

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const row of page.rows) {
    if (fabrikantCardUrlKind(row.cardUrl) !== "v2") continue;
    if (seen.has(row.procedureNumber)) continue;
    seen.add(row.procedureNumber);
    urls.push(row.cardUrl);
    if (urls.length >= wanted) break;
  }
  console.log(`Процедур с карточкой /v2: ${urls.length}`);
  console.log();

  let deadlineInLots = 0;
  let deadlineOnlyInProcedurePanels = 0;
  let deadlineNowhere = 0;

  for (const cardUrl of urls) {
    const html = await fetchText(fabrikantCardPageUrl(cardUrl, 1));
    const card = parseFabrikantCard(html);
    const levels = panelLevels(html);

    const lotsWithDeadline = card.lots.filter((lot) => lot.submissionEnd !== "").length;
    const lotsWithout = card.lots.length - lotsWithDeadline;

    const procedureDatePanels = levels.procedure.filter((key) => DATEISH.test(key));
    const lotDatePanels = [...new Set(levels.lot.filter((key) => DATEISH.test(key)))];

    // Главный вопрос: есть ли `proposal_date_stop` среди панелей процедуры.
    const procedureStop = procedureDatePanels.filter((key) => key === "proposal_date_stop");
    const stopShape = procedureStop.map((key) => panelDateShape(html, key))[0];
    const stopReadable = stopShape !== undefined && stopShape.parsed !== "";

    let verdict: string;
    if (lotsWithDeadline > 0) {
      deadlineInLots += 1;
      verdict = "срок в лотах — разбор его видит";
    } else if (stopReadable) {
      deadlineOnlyInProcedurePanels += 1;
      verdict = "срок напечатан панелью ПРОЦЕДУРЫ — разбор его теряет";
    } else {
      deadlineNowhere += 1;
      verdict = "срока нет ни в лотах, ни в панелях процедуры";
    }

    console.log(
      `Процедура ${card.eisNumber ?? "(без номера ЕИС)"} · лотов ${card.lots.length} ` +
        `(объявлено ${card.declaredLotCount ?? "?"}, контейнеров ${levels.lotContainers}) · ` +
        `со сроком ${lotsWithDeadline}, без срока ${lotsWithout}`,
    );
    console.log(`  панели процедуры с датой: ${procedureDatePanels.join(", ") || "(нет)"}`);
    console.log(`  панели лотов с датой: ${lotDatePanels.join(", ") || "(нет)"}`);
    if (stopShape !== undefined) {
      console.log(
        `  proposal_date_stop процедуры: дат в значении ${stopShape.dates}, ` +
          `разбор даёт ${stopShape.parsed === "" ? "пусто" : stopShape.parsed}`,
      );
    }
    for (const key of procedureDatePanels.filter((one) => one !== "proposal_date_stop")) {
      const shape = panelDateShape(html, key);
      console.log(`  ${key} процедуры: дат ${shape.dates}, разбор ${shape.parsed === "" ? "пусто" : shape.parsed}`);
    }
    console.log(`  всего панелей: процедуры ${levels.procedure.length}, лотов ${levels.lot.length}`);
    console.log(`  размер страницы: ${html.length} символов`);
    console.log(`  вывод: ${verdict}`);
    console.log();

    await pause(600);
  }

  console.log("Итог по осмотренным процедурам:");
  console.log(`  срок в лотах (разбор видит): ${deadlineInLots}`);
  console.log(`  срок панелью процедуры (разбор теряет): ${deadlineOnlyInProcedurePanels}`);
  console.log(`  срока нет нигде: ${deadlineNowhere}`);
}

main().catch((error: unknown) => {
  console.error(`Зонд не выполнен: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
