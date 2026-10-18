import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EnqueueSyncJobResponse, SyncJobsStatusResponse } from "@/services/syncJobApiService";
import { syncJobApiService } from "@/services/syncJobApiService";
import { NewTendersButton, NewTendersStatus, useTendersSearch } from "@/components/dashboard/NewTendersSearch";

/** Кнопка и полоса хода — как их раскладывают страницы: два места, одно состояние. */
function NewTendersSearch({ busy, onFinished }: { busy?: boolean; onFinished?: () => void }) {
  const search = useTendersSearch(onFinished);
  return (
    <>
      <NewTendersButton search={search} busy={busy} />
      <NewTendersStatus search={search} />
    </>
  );
}

vi.mock("@/services/syncJobApiService", () => ({
  syncJobApiService: { getStatus: vi.fn(), enqueueFullSync: vi.fn() },
}));

/** Только поля, которые читает компонент: остальное строки задания ему не нужно. */
const job = (status: "pending" | "processing" | "completed", kind = "full_sync") => ({ id: "j1", kind, status }) as never;
const status = (recent: unknown[]) => ({ recent }) as unknown as SyncJobsStatusResponse;
const enqueued = (patch: Partial<EnqueueSyncJobResponse> = {}) =>
  ({ job: job("pending"), deduped: false, view: {}, ...patch }) as unknown as EnqueueSyncJobResponse;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(syncJobApiService.getStatus).mockResolvedValue(status([]));
  vi.mocked(syncJobApiService.enqueueFullSync).mockResolvedValue(enqueued());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("NewTendersSearch — поиск одной кнопкой", () => {
  it("одна кнопка: нажатие сразу запускает поиск, второй кнопки «Запустить» нет", async () => {
    render(<NewTendersSearch />);
    await flush();

    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Найти новые закупки" }));
    await flush();

    expect(syncJobApiService.enqueueFullSync).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Запустить поиск/ })).toBeNull();
  });

  it("идущий поиск показан индикатором с этапами, кнопка заблокирована", async () => {
    render(<NewTendersSearch />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Найти новые закупки" }));
    await flush();

    const progress = screen.getByTestId("work-progress");
    expect(progress.textContent).toContain("Ищем новые закупки");
    expect(progress.textContent).toContain("Принимаем запрос");
    expect((screen.getByRole("button", { name: /Ищем новые закупки/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("поиск уже идёт при открытии страницы — показан ход, а не предложение запустить второй", async () => {
    vi.mocked(syncJobApiService.getStatus).mockResolvedValue(status([job("processing")]));
    render(<NewTendersSearch />);
    await flush();

    expect(screen.getByTestId("work-progress")).toBeTruthy();
    expect(syncJobApiService.enqueueFullSync).not.toHaveBeenCalled();
  });

  it("поиск закончился — сообщение и перечитывание ленты", async () => {
    const onFinished = vi.fn();
    vi.mocked(syncJobApiService.getStatus).mockResolvedValue(status([job("processing")]));
    render(<NewTendersSearch onFinished={onFinished} />);
    await flush();

    vi.mocked(syncJobApiService.getStatus).mockResolvedValue(status([job("completed")]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });

    expect(screen.queryByTestId("work-progress")).toBeNull();
    expect(screen.getByText(/Поиск завершён/)).toBeTruthy();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("прогон закончился, но ЕИС ограничила доступ — об этом сказано, а не «лента обновлена»", async () => {
    const note =
      "Готово: 12 сохранено, 0 документов, 0 уже было от другого источника, 0 ошибок, 90.1 с" +
      " · ЕИС временно ограничила доступ — закупки с неё не обновились, повторим после 15:42 МСК";
    vi.mocked(syncJobApiService.getStatus).mockResolvedValue(status([job("processing")]));
    render(<NewTendersSearch />);
    await flush();

    vi.mocked(syncJobApiService.getStatus).mockResolvedValue(
      status([{ ...(job("completed") as object), report: { note } }]),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });

    const message = screen.getByRole("status");
    expect(message.textContent).toContain("лента обновлена не полностью");
    expect(message.textContent).toContain("ЕИС временно ограничила доступ — закупки с неё не обновились, повторим после 15:42 МСК");
    expect(message.className).toContain("text-mustard-fg");
  });

  it("отказ — человеческая фраза без технических подробностей; причина только в подсказке", async () => {
    vi.mocked(syncJobApiService.enqueueFullSync).mockRejectedValue(new Error("Очередь заданий не настроена: миграция"));
    render(<NewTendersSearch />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Найти новые закупки" }));
    await flush();

    const note = screen.getByText(/Не удалось запустить поиск/);
    expect(note.textContent).not.toMatch(/очеред|миграц|сервер/i);
    expect(note.getAttribute("title")).toContain("Очередь заданий не настроена");
  });

  it("в интерфейсе нет ни перечня площадок, ни слов про сервер и воркер", async () => {
    render(<NewTendersSearch />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Найти новые закупки" }));
    await flush();

    expect(document.body.textContent).not.toMatch(/сервер|воркер|ЕИС|Росэлторг|Фабрикант|очеред/i);
  });

  it("ссылка «Добавить по ссылке» на месте, пока поиск не идёт", async () => {
    render(<NewTendersSearch />);
    await flush();

    expect(screen.getByRole("link", { name: "Добавить по ссылке" }).getAttribute("href")).toBe("/tenders/import");
  });
});
