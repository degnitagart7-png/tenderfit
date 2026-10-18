import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchAssistBar } from "@/components/tenders/SearchAssistBar";

/**
 * Панель помощника поиска: расширить запрос и проверить выдачу по смыслу.
 *
 * Обе кнопки платные (за ними вызов языковой модели), поэтому ничего не
 * происходит само: ни при вводе запроса, ни при открытии страницы.
 */

const candidates = [
  { id: "t1", subject: "Оказание комплекса юридических услуг", customer: "ПАО МОЭК" },
  { id: "t2", subject: "Оказание услуг связи юридическому лицу" },
];

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderBar(overrides: Partial<React.ComponentProps<typeof SearchAssistBar>> = {}) {
  const props = {
    query: "юридические услуги",
    candidates,
    verdicts: null,
    hideNo: false,
    onAddKeywords: vi.fn(),
    onVerdicts: vi.fn(),
    onHideNo: vi.fn(),
    onLiveDone: vi.fn(),
    livePollMs: 1,
    ...overrides,
  };
  render(<SearchAssistBar {...props} />);
  return props;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SearchAssistBar", () => {
  it("без запроса панели нет: помогать не с чем", () => {
    renderBar({ query: "" });

    expect(screen.queryByRole("button", { name: /формулировки/i })).toBeNull();
  });

  it("при открытии ничего не запрашивает: за вызовом стоят токены", () => {
    renderBar();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("«Предложить формулировки» отправляет запрос и показывает варианты", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ synonyms: ["юрист", "адвокат"], cached: false }));
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: /формулировки/i }));

    expect(await screen.findByRole("button", { name: "юрист" })).toBeTruthy();
    const call = vi.mocked(fetch).mock.calls[0];
    expect(String(call?.[0])).toBe("/api/search/expand");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ query: "юридические услуги" });
  });

  it("клик по варианту добавляет его в поиск", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ synonyms: ["юрист", "адвокат"], cached: false }));
    const props = renderBar();

    fireEvent.click(screen.getByRole("button", { name: /формулировки/i }));
    fireEvent.click(await screen.findByRole("button", { name: "юрист" }));

    expect(props.onAddKeywords).toHaveBeenCalledWith(["юрист"]);
  });

  it("«Добавить все» добавляет все варианты разом", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ synonyms: ["юрист", "адвокат"], cached: false }));
    const props = renderBar();

    fireEvent.click(screen.getByRole("button", { name: /формулировки/i }));
    fireEvent.click(await screen.findByRole("button", { name: /добавить все/i }));

    expect(props.onAddKeywords).toHaveBeenCalledWith(["юрист", "адвокат"]);
  });

  it("уже добавленный в поиск вариант не предлагается второй раз", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ synonyms: ["юрист", "адвокат"], cached: false }));
    renderBar({ keywords: ["юрист"] });

    fireEvent.click(screen.getByRole("button", { name: /формулировки/i }));

    expect(await screen.findByRole("button", { name: "адвокат" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "юрист" })).toBeNull();
  });

  it("«Проверить по смыслу» отправляет закупки и отдаёт оценки наверх", async () => {
    vi.mocked(fetch).mockResolvedValue(
      answer({
        verdicts: { t1: { fit: "yes", reason: "то самое" }, t2: { fit: "no", reason: "юридическое лицо" } },
        cached: false,
      }),
    );
    const props = renderBar({ companyNote: "Юридическая фирма" });

    fireEvent.click(screen.getByRole("button", { name: /по смыслу/i }));

    await waitFor(() => expect(props.onVerdicts).toHaveBeenCalled());
    const sent = JSON.parse(String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body));
    expect(sent.query).toBe("юридические услуги");
    expect(sent.companyNote).toBe("Юридическая фирма");
    expect(sent.candidates).toEqual(candidates);
    expect(props.onVerdicts).toHaveBeenCalledWith({
      t1: { fit: "yes", reason: "то самое" },
      t2: { fit: "no", reason: "юридическое лицо" },
    });
  });

  it("когда оценки получены, итог назван словами", () => {
    renderBar({
      verdicts: {
        t1: { fit: "yes", reason: "то самое" },
        t2: { fit: "no", reason: "другое" },
      },
    });

    expect(screen.getByText(/подходят: 1/)).toBeTruthy();
    expect(screen.getByText(/не подходят: 1/)).toBeTruthy();
  });

  it("переключатель «Скрыть неподходящие» меняет состояние наверху", () => {
    const props = renderBar({
      verdicts: { t1: { fit: "yes", reason: "x" }, t2: { fit: "no", reason: "y" } },
    });

    fireEvent.click(screen.getByLabelText(/скрыть неподходящие/i));

    expect(props.onHideNo).toHaveBeenCalledWith(true);
  });

  it("лимит запросов называется прямо, а не «ошибкой»", async () => {
    vi.mocked(fetch).mockResolvedValue(
      answer({ error: "Слишком много запросов к помощнику. Подождите немного.", retryAfterSec: 120 }, 429),
    );
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: /формулировки/i }));

    expect(await screen.findByText(/слишком много запросов/i)).toBeTruthy();
  });

  it("сбой модели не ломает панель: сообщение и можно повторить", async () => {
    vi.mocked(fetch).mockResolvedValue(answer({ error: "Шлюз модели ответил 502" }, 502));
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: /формулировки/i }));

    expect(await screen.findByText(/не удалось/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /формулировки/i })).toBeTruthy();
  });

  it("нет закупок для проверки — кнопка неактивна", () => {
    renderBar({ candidates: [] });

    expect((screen.getByRole("button", { name: /по смыслу/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  /*
    Живой поиск: запрос уходит на площадки, а страница ждёт, пока воркер
    закончит. Прогон идёт минуты, поэтому кнопка опрашивает состояние задания и
    по окончании просит ленту перечитать базу.
  */
  describe("живой поиск", () => {
    it("кнопка «Искать на площадках» есть", () => {
      renderBar();

      expect(screen.getByRole("button", { name: /искать на площадках/i })).toBeTruthy();
    });

    it("отправляет запрос, ждёт завершения и просит перечитать ленту", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(answer({ jobId: "j1", status: "pending" }))
        .mockResolvedValueOnce(answer({ jobId: "j1", status: "processing", note: null, failed: false }))
        .mockResolvedValueOnce(
          answer({ jobId: "j1", status: "completed", note: "Готово: 40 сохранено", failed: false }),
        );
      const props = renderBar();

      fireEvent.click(screen.getByRole("button", { name: /искать на площадках/i }));

      await waitFor(() => expect(props.onLiveDone).toHaveBeenCalledTimes(1));
      const first = vi.mocked(fetch).mock.calls[0];
      expect(String(first?.[0])).toBe("/api/search/live");
      expect(JSON.parse(String((first?.[1] as RequestInit).body))).toEqual({ query: "юридические услуги" });
      expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain("jobId=j1");
      expect(screen.getByText(/готово: 40 сохранено/i)).toBeTruthy();
    });

    it("ЕИС ограничила доступ — итог показан как предупреждение, а не как успех", async () => {
      const note =
        "Готово: 5 сохранено, 0 документов, 0 уже было от другого источника, 0 ошибок, 60.0 с" +
        " · ЕИС временно ограничила доступ — закупки с неё не обновились, повторим после 15:42 МСК";
      vi.mocked(fetch)
        .mockResolvedValueOnce(answer({ jobId: "j1", status: "pending" }))
        .mockResolvedValueOnce(answer({ jobId: "j1", status: "completed", note, failed: false }));
      const props = renderBar();

      fireEvent.click(screen.getByRole("button", { name: /искать на площадках/i }));

      await waitFor(() => expect(props.onLiveDone).toHaveBeenCalledTimes(1));
      const message = screen.getByText(/ЕИС временно ограничила доступ/);
      expect(message.className).toContain("text-mustard-fg");
      expect(message.className).not.toContain("text-olive-fg");
    });

    it("регионы ленты уходят вместе с запросом: ЕИС ищет по региону заказчика", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(answer({ jobId: "j1", status: "completed", cached: true }));
      renderBar({ regions: ["Республика Бурятия"] });

      fireEvent.click(screen.getByRole("button", { name: /искать на площадках/i }));

      await waitFor(() => expect(fetch).toHaveBeenCalled());
      const first = vi.mocked(fetch).mock.calls[0];
      expect(JSON.parse(String((first?.[1] as RequestInit).body))).toEqual({
        query: "юридические услуги",
        regions: ["Республика Бурятия"],
      });
    });

    it("пока идёт поиск, кнопка неактивна и говорит об этом", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(answer({ jobId: "j1", status: "pending" }))
        .mockResolvedValue(answer({ jobId: "j1", status: "processing", note: null, failed: false }));
      renderBar();

      fireEvent.click(screen.getByRole("button", { name: /искать на площадках/i }));

      const busy = await screen.findByRole("button", { name: /ищу на площадках/i });
      expect((busy as HTMLButtonElement).disabled).toBe(true);
    });

    it("недавний запрос не повторяется: данные уже в базе, лента перечитывается сразу", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(answer({ jobId: "j1", status: "completed", cached: true }));
      const props = renderBar();

      fireEvent.click(screen.getByRole("button", { name: /искать на площадках/i }));

      await waitFor(() => expect(props.onLiveDone).toHaveBeenCalled());
      expect(screen.getByText(/уже искали/i)).toBeTruthy();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("отказ сервера объясняется словами сервера", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        answer({ error: "Сервер сейчас ищет другой запрос. Подождите несколько минут и повторите." }, 429),
      );
      const props = renderBar();

      fireEvent.click(screen.getByRole("button", { name: /искать на площадках/i }));

      expect(await screen.findByText(/сейчас ищет другой запрос/i)).toBeTruthy();
      expect(props.onLiveDone).not.toHaveBeenCalled();
    });

    it("задание упало — сообщение, а не вечное ожидание", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(answer({ jobId: "j1", status: "pending" }))
        .mockResolvedValueOnce(answer({ jobId: "j1", status: "failed", note: null, failed: true }));
      const props = renderBar();

      fireEvent.click(screen.getByRole("button", { name: /искать на площадках/i }));

      expect(await screen.findByText(/поиск не удался/i)).toBeTruthy();
      expect(props.onLiveDone).not.toHaveBeenCalled();
    });
  });
});
