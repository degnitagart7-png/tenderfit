import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeepAnalysisPanel } from "@/components/tenders/DeepAnalysisPanel";
import { deepAnalysisService } from "@/services/deepAnalysisService";
import type { DeepAnalysisStatus, KonturCardStatus } from "@/services/deepAnalysisService";

vi.mock("@/services/deepAnalysisService", () => ({
  deepAnalysisService: {
    getStatus: vi.fn(),
    trigger: vi.fn(),
    getKonturCard: vi.fn(),
    buyKonturCard: vi.fn(),
  },
}));

const REG_NUMBER = "0573100026626000009";

/** Номер живой коммерческой закупки, для которой карточка — единственный путь. */
const COMMERCIAL_REG_NUMBER = "RH24092600035";

const EMPTY: DeepAnalysisStatus = {
  jobs: [],
  verdictHistory: [],
  documents: [],
  documentAnalyses: [],
};

function mockStatus(status: DeepAnalysisStatus) {
  vi.mocked(deepAnalysisService.getStatus).mockResolvedValue(status);
}

function cardStatus(overrides: Partial<KonturCardStatus> = {}): KonturCardStatus {
  return {
    regNumber: COMMERCIAL_REG_NUMBER,
    show: true,
    allowed: true,
    reason: null,
    refusalKind: null,
    budgetNote: "Карточек Контур.Закупок сегодня: 2 из 30, осталось 28",
    cardSpentToday: 2,
    cardLimit: 30,
    analysisRemaining: 15,
    ...overrides,
  };
}

const CARD_HEADING = "Документацию этой закупки можно только купить";
const BUY_BUTTON = "Купить карточку Контур.Закупок";

/** Строка документа с прочитанным текстом — как её пишет documentRepository.saveParsed. */
function parsedRow(overrides: Record<string, unknown>) {
  return {
    document_type: "attachment",
    source_type: "eis_api",
    parsed_status: "parsed",
    download_status: "downloaded",
    content_hash: "a".repeat(64),
    error_message: null,
    created_at: "2026-09-21T21:10:00Z",
    updated_at: "2026-09-21T21:10:00Z",
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus(EMPTY);
  vi.mocked(deepAnalysisService.trigger).mockResolvedValue({
    job: { id: "job-1", status: "pending" } as never,
    deduped: false,
  });
  // По умолчанию блока нет: закупки ЕИС документацию получают бесплатно, и
  // остальные тесты панели платный путь не riguardano.
  vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue(
    cardStatus({ show: false, allowed: false }),
  );
  vi.mocked(deepAnalysisService.buyKonturCard).mockResolvedValue({
    status: "queued",
    jobId: "job-docs-1",
    analysisJobId: "job-analysis-1",
    deduped: false,
    budgetNote: "Карточек Контур.Закупок сегодня: 3 из 30, осталось 27",
    warning: null,
  });
});

describe("DeepAnalysisPanel", () => {
  it("без задач предлагает запустить анализ", async () => {
    render(<DeepAnalysisPanel tenderId={REG_NUMBER} dataSource="EIS" subject="Тестовая закупка" />);

    expect(await screen.findByText("Глубокий анализ не запускался")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Запустить глубокий анализ" }));

    expect(deepAnalysisService.trigger).toHaveBeenCalledWith(REG_NUMBER);
    // После постановки в очередь панель перечитывает состояние, а не рисует его сама.
    await waitFor(() => expect(deepAnalysisService.getStatus).toHaveBeenCalledTimes(2));
  });

  it("отказ по суточному лимиту показывает причину, а не общий сбой", async () => {
    // Сервер отвечает 429 с готовой фразой; deepAnalysisService.parseError её
    // прокидывает. Панель обязана показать именно текст про лимит — иначе партнёр
    // решит, что разбор сломался, и будет жать кнопку повторно.
    vi.mocked(deepAnalysisService.trigger).mockRejectedValue(
      new Error("Суточный лимит разборов исчерпан: 20 за день. Следующий можно поставить после 00:00 по Москве."),
    );

    render(<DeepAnalysisPanel tenderId={REG_NUMBER} dataSource="EIS" subject="Тестовая закупка" />);

    await fireEvent.click(await screen.findByRole("button", { name: "Запустить глубокий анализ" }));

    expect(await screen.findByText(/Суточный лимит разборов исчерпан: 20 за день/)).toBeTruthy();
    // Кнопка остаётся: лимит сбрасывается в полночь, и панель не должна выглядеть сломанной.
    expect(screen.getByRole("button", { name: "Запустить глубокий анализ" })).toBeTruthy();
  });

  it("объясняет ожидание документации от плановой синхронизации", async () => {
    mockStatus({
      ...EMPTY,
      jobs: [{ id: "job-1", status: "pending" } as never],
    });

    render(<DeepAnalysisPanel tenderId={REG_NUMBER} dataSource="EIS" subject="Тестовая закупка" />);

    expect(await screen.findByText("В очереди на загрузку документации")).toBeTruthy();
    expect(screen.getByText(/каждые 2 часа/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Запустить глубокий анализ" })).toBeNull();
  });

  it("показывает документы и факторы с цитатами из текста", async () => {
    mockStatus({
      jobs: [{ id: "job-1", status: "completed" } as never],
      verdictHistory: [
        {
          id: "vh-1",
          old_verdict: null,
          new_verdict: "NOT_RECOMMENDED",
          reason: "Обнаружены блокирующие факторы: Нет лицензии ФСТЭК",
          triggered_by: "document_analysis",
          created_at: "2026-09-21T21:05:00Z",
        } as never,
      ],
      documents: [
        {
          id: "doc-1",
          filename: "print-form-1.html",
          document_type: "notice",
          source_type: "eis_api",
          file_url: "https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=1",
          parsed_status: "parsed",
          download_status: "downloaded",
          content_hash: "a".repeat(64),
          file_size: 432708,
          error_message: null,
          created_at: "2026-09-21T20:57:43Z",
          updated_at: "2026-09-21T20:57:43Z",
          raw_json: { title: "Извещение о закупке (печатная форма)" },
        } as never,
      ],
      documentAnalyses: [
        {
          id: "an-1",
          model_used: "google/gemini-2.5-flash",
          analysis: {
            summary: "Найдено блокирующее требование",
            findings: [
              {
                category: "blocker",
                title: "Нужна лицензия ФСТЭК",
                detail: "Без лицензии участие невозможно",
                evidence_quote: "Наличие лицензии ФСТЭК России на деятельность по защите информации",
                evidence_section: "Раздел 3. Требования к участникам",
                severity: "high",
              },
            ],
          },
          tokens_used: 1200,
          processing_time_ms: 8400,
          created_at: "2026-09-21T21:00:00Z",
        } as never,
      ],
    });

    render(<DeepAnalysisPanel tenderId={REG_NUMBER} dataSource="EIS" subject="Тестовая закупка" />);

    expect(await screen.findByText("Разбор завершён")).toBeTruthy();
    // Документ: заголовок из raw_json и размер в читаемом виде.
    expect(screen.getByText("Извещение о закупке (печатная форма)")).toBeTruthy();
    expect(screen.getByText(/423 КБ/)).toBeTruthy();
    // Фактор: категория, заголовок и цитата с указанием раздела.
    expect(screen.getByText("Блокирующие факторы")).toBeTruthy();
    expect(screen.getByText("Нужна лицензия ФСТЭК")).toBeTruthy();
    expect(screen.getByText(/Наличие лицензии ФСТЭК России/)).toBeTruthy();
    expect(screen.getByText(/Раздел 3. Требования к участникам/)).toBeTruthy();
    // Вердикт пересмотрен именно разбором документации.
    expect(screen.getByText(/Вердикт пересмотрен/)).toBeTruthy();
    // Чем сделан вывод.
    expect(screen.getByText(/google\/gemini-2\.5-flash/)).toBeTruthy();
  });

  it("для Сбербанк-АСТ говорит правду про документацию", async () => {
    render(<DeepAnalysisPanel tenderId="sber-1" dataSource="SBER_AST" subject="Тестовая закупка" />);

    expect(await screen.findByText("Недоступно для этого источника")).toBeTruthy();
    expect(screen.getByText(/КЭП/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Запустить глубокий анализ" })).toBeNull();
  });

  it("показывает сохранённую причину сбоя и кнопку повторного запуска", async () => {
    mockStatus({
      ...EMPTY,
      jobs: [{ id: "job-1", status: "failed", error_message: "OpenRouter 429" } as never],
    });

    render(<DeepAnalysisPanel tenderId={REG_NUMBER} dataSource="EIS" subject="Тестовая закупка" />);

    expect(await screen.findByText("Разбор не выполнен")).toBeTruthy();
    expect(screen.getByText("OpenRouter 429")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Запустить глубокий анализ" })).toBeTruthy();
  });

  it("сообщает, когда состояние получить не удалось", async () => {
    vi.mocked(deepAnalysisService.getStatus).mockRejectedValue(new Error("Supabase недоступен"));

    render(<DeepAnalysisPanel tenderId={REG_NUMBER} dataSource="EIS" subject="Тестовая закупка" />);

    expect(await screen.findByText("Supabase недоступен")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeTruthy();
  });

  it("пропущенное вложение показывает причину, а не сбой разбора", async () => {
    mockStatus({
      jobs: [{ id: "job-1", status: "completed", documents_processed: 1 } as never],
      verdictHistory: [],
      documents: [
        {
          id: "doc-1",
          filename: "print-form-1.html",
          document_type: "notice",
          source_type: "eis_api",
          file_url: "https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=1",
          parsed_status: "parsed",
          download_status: "downloaded",
          content_hash: "a".repeat(64),
          file_size: 432708,
          error_message: null,
          created_at: "2026-09-21T20:57:43Z",
          updated_at: "2026-09-21T20:57:43Z",
          raw_json: { title: "Извещение о закупке (печатная форма)", chars: 12_480 },
        } as never,
        // Два тома одного архива: причина совпадает до байта, в списке остаётся одна строка.
        {
          id: "doc-2",
          filename: "Йошкар Ола ПСД.part01.rar",
          document_type: "attachment",
          source_type: "eis_api",
          file_url: "https://zakupki.gov.ru/files/1.rar",
          parsed_status: "failed",
          download_status: "failed",
          content_hash: null,
          file_size: 314_572_800,
          error_message: "Файл объёмом 314.6 МБ больше предела 50 МБ и не читается.",
          created_at: "2026-09-21T21:10:00Z",
          updated_at: "2026-09-21T21:10:00Z",
          raw_json: {
            title: "Проектная документация, том 1",
            chars: 0,
            skipped: { code: "file_too_large", reason: "Файл объёмом 314.6 МБ больше предела 50 МБ и не читается." },
          },
        } as never,
        {
          id: "doc-3",
          filename: "Йошкар Ола ПСД.part02.rar",
          document_type: "attachment",
          source_type: "eis_api",
          file_url: "https://zakupki.gov.ru/files/2.rar",
          parsed_status: "failed",
          download_status: "failed",
          content_hash: null,
          file_size: 314_572_800,
          error_message: "Файл объёмом 314.6 МБ больше предела 50 МБ и не читается.",
          created_at: "2026-09-21T21:10:01Z",
          updated_at: "2026-09-21T21:10:01Z",
          raw_json: {
            title: "Проектная документация, том 2",
            chars: 0,
            skipped: { code: "file_too_large", reason: "Файл объёмом 314.6 МБ больше предела 50 МБ и не читается." },
          },
        } as never,
      ],
      documentAnalyses: [
        {
          id: "an-1",
          model_used: "google/gemini-2.5-flash",
          analysis: { summary: "Извещение разобрано", findings: [] },
          tokens_used: 1200,
          processing_time_ms: 8400,
          created_at: "2026-09-21T21:12:00Z",
        } as never,
      ],
    });

    render(<DeepAnalysisPanel tenderId={REG_NUMBER} dataSource="EIS" subject="Тестовая закупка" />);

    expect(await screen.findByText("Разбор завершён")).toBeTruthy();
    // Счёт файлов называется один раз — в строке состояния, а не дважды.
    expect(screen.getByText(/Прочитан 1 файл из 3/)).toBeTruthy();
    expect(screen.queryByText(/1 с текстом, пропущено 2/)).toBeNull();
    expect(
      screen.getByText(/Документация прочитана не вся: пропущено 2 — детали в списке ниже/),
    ).toBeTruthy();
    // Пропуск подписан своим словом и причиной, а не красной ошибкой разбора.
    expect(screen.getAllByText(/^Пропущен/)).toHaveLength(1);
    expect(screen.getByText("Файл объёмом 314.6 МБ больше предела 50 МБ и не читается.")).toBeTruthy();
    expect(screen.queryByText(/Текст получить не удалось/)).toBeNull();
    // Второй том схлопнут, но не потерян: партнёр видит, что таких файлов больше.
    expect(screen.getByText(/и ещё 1 файл с той же причиной/)).toBeTruthy();
    expect(screen.getByText("Проектная документация, том 1")).toBeTruthy();
    expect(screen.queryByText("Проектная документация, том 2")).toBeNull();
    // Пропуск не мешает показывать документ с текстом.
    expect(screen.getByText("Извещение о закупке (печатная форма)")).toBeTruthy();
  });

  it("обрезанный по бюджету документ помечен, а не выдан за прочитанный целиком", async () => {
    mockStatus({
      jobs: [{ id: "job-1", status: "completed", documents_processed: 2 } as never],
      verdictHistory: [],
      documents: [
        // Закупка 32616393585: архив документации о закупке из 15 вложений
        // отдал модели два — на остальные не хватило остатка бюджета знаков.
        parsedRow({
          id: "doc-1",
          filename: "ДОЗ.zip",
          file_url: "https://zakupki.gov.ru/files/doz.zip",
          file_size: 18_350_080,
          raw_json: {
            title: "Документация о закупке",
            chars: 173_598,
            truncated: true,
            archive: { parsed: 2, total: 15 },
          },
        }),
        parsedRow({
          id: "doc-2",
          filename: "Обоснование НМЦК.xlsx",
          file_url: "https://zakupki.gov.ru/files/nmck.xlsx",
          file_size: 24_576,
          raw_json: { title: "Обоснование НМЦК", chars: 1_307, truncated: true },
        }),
      ],
      documentAnalyses: [
        {
          id: "an-1",
          model_used: "google/gemini-2.5-flash",
          analysis: { summary: "Документация разобрана", findings: [] },
          tokens_used: 4100,
          processing_time_ms: 9100,
          created_at: "2026-09-21T21:12:00Z",
        } as never,
      ],
    });

    render(<DeepAnalysisPanel tenderId="32616393585" dataSource="EIS" subject="Тестовая закупка" />);

    expect(await screen.findByText("Разбор завершён")).toBeTruthy();
    // Итоговая строка говорит о неполноте, а не только о факторах.
    expect(
      screen.getByText(/Документация прочитана не вся: обрезано 2 — детали в списке ниже/),
    ).toBeTruthy();
    // Архив: партнёру важно видеть, сколько вложений вообще дошло до модели.
    expect(
      screen.getByText(
        "В разбор попала часть текста: бюджет знаков на закупку кончился, " +
          "из архива прочитано 2 из 15 файлов.",
      ),
    ).toBeTruthy();
    // Обычный файл: без архивного счётчика.
    expect(
      screen.getByText("В разбор попала часть текста: бюджет знаков на закупку кончился."),
    ).toBeTruthy();
    // Обрезка — не сбой: красный текст ошибки разбора не появляется.
    expect(screen.queryByText(/Текст получить не удалось/)).toBeNull();
    expect(screen.getByText("Документация о закупке")).toBeTruthy();
    expect(screen.getByText("Обоснование НМЦК")).toBeTruthy();
  });
});

/*
  Платная карточка Контур.Закупок — единственный источник документации для
  коммерческой закупки, размещённой только на площадке. Блок обязан называть
  цену до нажатия, требовать явного подтверждения и не появляться там, где те же
  файлы бесплатно отдаёт ЕИС.
*/
describe("платная карточка Контур.Закупок", () => {
  function renderCommercial() {
    return render(
      <DeepAnalysisPanel tenderId={COMMERCIAL_REG_NUMBER} dataSource="KONTUR" subject="Тестовая закупка" />,
    );
  }

  async function openConfirmation() {
    await fireEvent.click(await screen.findByRole("button", { name: BUY_BUTTON }));
  }

  it("предлагает покупку там, где ЕИС документацию не публикует", async () => {
    vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue(cardStatus());

    renderCommercial();

    expect(await screen.findByText(CARD_HEADING)).toBeTruthy();
    // Обещание плановой синхронизации здесь не выполняется — блок говорит об этом прямо.
    expect(screen.getByText(/ЕИС не публикует вкладку документов/)).toBeTruthy();
    expect(
      screen.getByText("Карточек Контур.Закупок сегодня: 2 из 30, осталось 28"),
    ).toBeTruthy();
    expect(screen.getByText(/осталось 15 из 20/)).toBeTruthy();
    // Риск назван до нажатия: деньги списываются и тогда, когда текста нет.
    expect(screen.getByText(/за логином площадки/)).toBeTruthy();
    expect(screen.getByRole("button", { name: BUY_BUTTON })).toBeTruthy();
    expect(deepAnalysisService.getKonturCard).toHaveBeenCalledWith(COMMERCIAL_REG_NUMBER);
  });

  it("очередь не обещает плановую догрузку там, где её не будет", async () => {
    mockStatus({ ...EMPTY, jobs: [{ id: "job-1", status: "pending" } as never] });
    vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue(cardStatus());

    renderCommercial();

    // Подпись состояния и предложение купить говорят об одном и том же пути,
    // а не противоречат друг другу на одном экране.
    expect(await screen.findByText(/Плановая синхронизация сюда не дойдёт/)).toBeTruthy();
    expect(screen.queryByText(/каждые 2 часа/)).toBeNull();
  });

  it("первое нажатие раскрывает подтверждение и не тратит запрос", async () => {
    vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue(cardStatus());

    renderCommercial();
    await openConfirmation();

    expect(deepAnalysisService.buyKonturCard).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Подтвердить/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(screen.getByRole("button", { name: BUY_BUTTON })).toBeTruthy();
    expect(deepAnalysisService.buyKonturCard).not.toHaveBeenCalled();
  });

  it("подтверждение ставит задание и объясняет, что будет дальше", async () => {
    vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue(cardStatus());

    renderCommercial();
    await openConfirmation();
    await fireEvent.click(screen.getByRole("button", { name: /Подтвердить/ }));

    expect(deepAnalysisService.buyKonturCard).toHaveBeenCalledWith(COMMERCIAL_REG_NUMBER);
    expect(await screen.findByText(/Задание поставлено/)).toBeTruthy();
    // Панель перечитывает состояние, а не рисует результат сама.
    await waitFor(() => expect(deepAnalysisService.getStatus).toHaveBeenCalledTimes(2));
  });

  it("предупреждение сервера показывается как есть", async () => {
    vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue(cardStatus());
    vi.mocked(deepAnalysisService.buyKonturCard).mockResolvedValue({
      status: "queued",
      jobId: "job-docs-1",
      analysisJobId: null,
      deduped: false,
      budgetNote: "Карточек Контур.Закупок сегодня: 3 из 30, осталось 27",
      warning: "Задачу разбора создать не удалось. Воркер создаст её сам, когда документация появится.",
    });

    renderCommercial();
    await openConfirmation();
    await fireEvent.click(screen.getByRole("button", { name: /Подтвердить/ }));

    expect(await screen.findByText(/Воркер создаст её сам/)).toBeTruthy();
  });

  it("отказ сервера показывает причину и возвращает кнопку", async () => {
    vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue(cardStatus());
    vi.mocked(deepAnalysisService.buyKonturCard).mockRejectedValue(
      new Error(
        "Суточный бюджет карточек Контур.Закупок исчерпан. Следующая попытка — после 00:00 по Москве.",
      ),
    );

    renderCommercial();
    await openConfirmation();
    await fireEvent.click(screen.getByRole("button", { name: /Подтвердить/ }));

    expect(await screen.findByText(/Суточный бюджет карточек/)).toBeTruthy();
    expect(screen.getByRole("button", { name: BUY_BUTTON })).toBeTruthy();
  });

  it("исчерпанный бюджет виден до нажатия, кнопки покупки нет", async () => {
    vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue(
      cardStatus({
        allowed: false,
        refusalKind: "budget",
        reason:
          "Суточный бюджет карточек Контур.Закупок исчерпан. Следующая попытка — после 00:00 по Москве.",
        budgetNote: "Карточек Контур.Закупок сегодня: 30 из 30, осталось 0",
      }),
    );

    renderCommercial();

    expect(await screen.findByText(CARD_HEADING)).toBeTruthy();
    expect(screen.getByText(/Суточный бюджет карточек/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: BUY_BUTTON })).toBeNull();
  });

  it("задача разбора уже стоит — новый расход лимита не обещается", async () => {
    vi.mocked(deepAnalysisService.getKonturCard).mockResolvedValue(
      cardStatus({ analysisRemaining: null }),
    );

    renderCommercial();

    expect(await screen.findByText(CARD_HEADING)).toBeTruthy();
    expect(screen.getByText(/Задача разбора уже стоит в очереди/)).toBeTruthy();
    expect(screen.queryByText(/осталось 15 из 20/)).toBeNull();
  });

  it("закупке с бесплатной документацией блок не показывается", async () => {
    render(<DeepAnalysisPanel tenderId={REG_NUMBER} dataSource="EIS" subject="Тестовая закупка" />);

    expect(await screen.findByText("Глубокий анализ не запускался")).toBeTruthy();
    expect(screen.queryByText(CARD_HEADING)).toBeNull();
  });

  it("сбой чтения состояния карточки не роняет панель", async () => {
    vi.mocked(deepAnalysisService.getKonturCard).mockRejectedValue(
      new Error("Очередь заданий недоступна"),
    );

    renderCommercial();

    // Основное состояние разбора остаётся на экране.
    expect(await screen.findByText("Глубокий анализ не запускался")).toBeTruthy();
    expect(screen.queryByText(CARD_HEADING)).toBeNull();
    // Сбой назван своей причиной и перечитывается, а не проглочен молча.
    expect(screen.getByText(/Состояние платной карточки не прочитано/)).toBeTruthy();
    expect(screen.getByText(/Очередь заданий недоступна/)).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    await waitFor(() => expect(deepAnalysisService.getKonturCard).toHaveBeenCalledTimes(2));
  });
});

describe("происхождение текста документации", () => {
  const DOCUMENTS: DeepAnalysisStatus = {
    ...EMPTY,
    jobs: [{ id: "job-1", status: "completed" } as never],
    documents: [
      parsedRow({
        id: "doc-1",
        filename: "print-form-1.html",
        file_url: "https://zakupki.gov.ru/epz/order/notice/printForm/view.html?regNumber=1",
        raw_json: { title: "Извещение о закупке" },
      }),
    ],
  };

  it("для закупки ЕИС называет ЕИС", async () => {
    mockStatus(DOCUMENTS);

    render(<DeepAnalysisPanel tenderId={REG_NUMBER} dataSource="EIS" subject="Тестовая закупка" />);

    expect(await screen.findByText(/Текст загружен сервером в России из ЕИС\./)).toBeTruthy();
  });

  it("для закупки Контур.Закупок не выдаёт текст за загруженный только из ЕИС", async () => {
    mockStatus(DOCUMENTS);

    render(<DeepAnalysisPanel tenderId={COMMERCIAL_REG_NUMBER} dataSource="KONTUR" subject="Тестовая закупка" />);

    expect(
      await screen.findByText(/из ЕИС или из карточки Контур\.Закупок/),
    ).toBeTruthy();
  });
});
