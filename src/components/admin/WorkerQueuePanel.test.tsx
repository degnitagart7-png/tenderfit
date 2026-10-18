/**
 * Тесты панели сервера в России и очереди заданий.
 *
 * Подпись состояния собирается настоящим `describeWorkerStatus`, а не
 * выдуманным объектом: панель обязана показывать ровно то, что домен говорит
 * о пульсе, адресе выхода и длине очереди. Если домен поменяет формулировку,
 * тест упадёт здесь, а не у партнёра на экране.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkerQueuePanel } from "@/components/admin/WorkerQueuePanel";
import type { SyncJobsStatusResponse } from "@/services/syncJobApiService";
import { syncJobApiService } from "@/services/syncJobApiService";
import { describeWorkerStatus } from "@/domain/workerStatus";
import { describeSyncJobReport } from "@/domain/syncJobReport";
import { redactSyncJob, redactSyncJobs } from "@/domain/syncJobRedaction";
import { formatDateTime } from "@/utils/format";
import type {
  SyncJobRow,
  WorkerHeartbeatRow,
  WorkerStatus,
} from "@/types/database";

vi.mock("@/services/syncJobApiService", () => ({
  syncJobApiService: { getStatus: vi.fn() },
}));

const NOW = "2026-09-25T03:00:00.000Z";

function heartbeat(overrides: Partial<WorkerHeartbeatRow> = {}): WorkerHeartbeatRow {
  return {
    worker_id: "ru-vps",
    last_seen_at: "2026-09-25T02:58:00.000Z",
    last_full_sync_at: "2026-09-25T02:00:00.000Z",
    exit_ip: "95.167.245.92",
    exit_country: "RU",
    host: "vps-1",
    version: "2026-09-25",
    last_job_id: null,
    last_error: null,
    created_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<SyncJobRow> = {}): SyncJobRow {
  return {
    id: "job-1",
    kind: "documents",
    status: "completed",
    payload: { regNumbers: ["01234567890", "01234567891"], reason: "press" },
    requested_by: null,
    attempts: 1,
    worker_id: "ru-vps",
    claimed_at: "2026-09-25T02:40:00.000Z",
    finished_at: "2026-09-25T02:44:00.000Z",
    report: { tenders: 2, documents: 7, already: 3, unavailable: 1 },
    error: null,
    created_at: "2026-09-25T02:39:00.000Z",
    updated_at: "2026-09-25T02:44:00.000Z",
    ...overrides,
  };
}

/** Ответ роута целиком: состояние собрано тем же доменным кодом, что на сервере. */
function statusResponse(overrides: {
  heartbeat?: WorkerHeartbeatRow | null;
  lastJob?: SyncJobRow | null;
  pending?: number;
  recent?: SyncJobRow[];
} = {}): SyncJobsStatusResponse {
  const status: WorkerStatus = {
    heartbeat: overrides.heartbeat === undefined ? heartbeat() : overrides.heartbeat,
    lastJob: overrides.lastJob === undefined ? job() : overrides.lastJob,
    pending: overrides.pending ?? 1,
  };
  return {
    configured: true,
    workerId: "ru-vps",
    now: NOW,
    // Задания проходят то же вычищение, что и на сервере: фикстура с текстом
    // документа должна доехать до панели в том виде, в каком её отдаёт роут,
    // иначе тест проверяет не журнал, а свою выдумку о нём.
    status: {
      ...status,
      lastJob: status.lastJob === null ? null : redactSyncJob(status.lastJob),
    },
    view: describeWorkerStatus(status, NOW),
    recent: redactSyncJobs(overrides.recent ?? [job()]),
  };
}

function mockStatus(response: SyncJobsStatusResponse): void {
  vi.mocked(syncJobApiService.getStatus).mockResolvedValue(response);
}

/** Дожидается ответа и долистывает очередь обновлений состояния. */
async function settled(): Promise<void> {
  await screen.findByRole("heading", { name: "Сервер в России и очередь заданий" });
  await waitFor(() => expect(vi.mocked(syncJobApiService.getStatus)).toHaveBeenCalled());
  await act(async () => {});
}

describe("WorkerQueuePanel — состояние сервера в России", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus(statusResponse());
  });

  it("просит журнал целиком, а не пять последних заданий", async () => {
    render(<WorkerQueuePanel />);
    await settled();

    // Панель владельца показывает очередь целиком: обрезанные пять записей
    // спрятали бы задание, которое упало час назад.
    expect(vi.mocked(syncJobApiService.getStatus)).toHaveBeenCalledWith(20);
  });

  it("пока ответа нет, сказано, что идёт чтение", () => {
    vi.mocked(syncJobApiService.getStatus).mockReturnValue(new Promise(() => {}));
    render(<WorkerQueuePanel />);

    expect(screen.getByText("Читаем состояние сервера…")).toBeTruthy();
  });

  it("сервер на связи: подпись, адрес выхода, очередь и последний прогон", async () => {
    render(<WorkerQueuePanel />);
    await settled();

    expect(screen.getByText("Сервер в России на связи 2 мин назад")).toBeTruthy();
    expect(screen.getByText(/Выход из России \(95\.167\.245\.92\)/)).toBeTruthy();
    // Имя машины видно владельцу: два сервера с разными именами в одной
    // очереди означали бы, что задания разбирает не тот, кого проверяют.
    expect(screen.getByText("ru-vps")).toBeTruthy();
    expect(screen.getByText(formatDateTime(heartbeat().last_seen_at))).toBeTruthy();
    // Момент последнего прогона по расписанию — отдельная плитка: по нему
    // видно, что сервер не только жив, но и делает свою работу.
    expect(screen.getByText("Прогон по расписанию")).toBeTruthy();
    expect(screen.getByText(formatDateTime(heartbeat().last_full_sync_at!))).toBeTruthy();
    expect(screen.getByText("95.167.245.92 (RU)")).toBeTruthy();
    expect(screen.getByText("2026-09-25")).toBeTruthy();
  });

  it("последнее задание показано доменным отчётом, а не номером строки", async () => {
    render(<WorkerQueuePanel />);
    await settled();

    const expected = describeSyncJobReport(job().report);
    expect(screen.getAllByText(new RegExp(expected, "u")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Последнее задание: Документация закупок · Выполнено/)).toBeTruthy();
  });

  it("без пульса сказано прямо, что сервер не настроен", async () => {
    mockStatus(statusResponse({ heartbeat: null, lastJob: null, pending: 0 }));
    render(<WorkerQueuePanel />);
    await settled();

    expect(screen.getByText("Сервер в России ещё не выходил на связь")).toBeTruthy();
    expect(
      screen.getByText(/документация к ним не загружается и глубокий разбор не выполняется/i),
    ).toBeTruthy();
    // Нули вместо прочерков означали бы «измерили и получили ноль»: для
    // отсутствующего пульса честнее прочерк.
    expect(screen.getByText("ещё не выполнялся")).toBeTruthy();
    expect(screen.getByText("не определён")).toBeTruthy();
    expect(screen.getByText("не сообщён")).toBeTruthy();
    expect(screen.getByText(/Заданий ещё не выполнялось/)).toBeTruthy();
  });

  it("зарубежный выход виден и в подписи, и в счётчике адреса", async () => {
    mockStatus(
      statusResponse({
        heartbeat: heartbeat({ exit_ip: "2.26.131.126", exit_country: "GB" }),
      }),
    );
    render(<WorkerQueuePanel />);
    await settled();

    expect(screen.getByText(/Сервер выходит в сеть не из России/)).toBeTruthy();
    expect(screen.getByText("2.26.131.126 (GB)")).toBeTruthy();
    expect(screen.getByText(/ЕИС и её хранилище файлов не отвечают зарубежным адресам/)).toBeTruthy();
  });

  it("сбой чтения показан причиной из ответа и читается повторно", async () => {
    vi.mocked(syncJobApiService.getStatus)
      .mockRejectedValueOnce(new Error("Очередь заданий не настроена: примените миграцию"))
      .mockResolvedValueOnce(statusResponse());
    render(<WorkerQueuePanel />);

    await screen.findByText(
      "Состояние сервера не прочитано: Очередь заданий не настроена: примените миграцию",
    );
    expect(screen.queryByText("Журнал заданий")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Повторить/i }));
    await waitFor(() => expect(vi.mocked(syncJobApiService.getStatus)).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(screen.getByText("Сервер в России на связи 2 мин назад")).toBeTruthy();
  });

  it("в подписях нет слова «воркер»: владелец ищет сервер, а не процесс", async () => {
    const { container } = render(<WorkerQueuePanel />);
    await settled();

    expect((container.textContent ?? "").toLowerCase()).not.toContain("воркер");
  });
});

describe("WorkerQueuePanel — журнал заданий", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("пустая очередь объясняет, кто и что в неё ставит", async () => {
    mockStatus(statusResponse({ pending: 0, recent: [], lastJob: null, heartbeat: null }));
    render(<WorkerQueuePanel />);
    await settled();

    expect(screen.getByText(/Заданий пока нет/)).toBeTruthy();
    // Прогон и документация — два разных задания, и ставит их не одна кнопка:
    // прогон по бесплатным площадкам — кнопка «Найти новые закупки», а
    // документацию найденных закупок — сервер после платного поиска. Подпись
    // обязана назвать прогон: иначе пустой журнал при только что нажатой кнопке
    // читается как «кнопка ничего не делает».
    expect(
      screen.getByText(/прогон по бесплатным площадкам ставит кнопка «Найти новые закупки»/i),
    ).toBeTruthy();
    expect(screen.getByText(/документацию найденных закупок — платный поиск/i)).toBeTruthy();
    // Подсказка про миграцию нужна именно здесь: пустой журнал при работающем
    // сервере почти всегда означает неприменённую миграцию, а не отсутствие работы.
    expect(screen.getByText(/20260925000004_add_sync_jobs\.sql/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("задание от кнопки видно по причине и числу закупок", async () => {
    mockStatus(statusResponse({ recent: [job()] }));
    render(<WorkerQueuePanel />);
    await settled();

    expect(screen.getByText("Документация закупок")).toBeTruthy();
    expect(screen.getByText("кнопка «Найти новые закупки»")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "2" })).toBeTruthy();
    expect(screen.getByText(formatDateTime(job().created_at))).toBeTruthy();
  });

  it("неудавшееся задание показывает причину, а не прочерк", async () => {
    mockStatus(
      statusResponse({
        recent: [
          job({
            id: "job-2",
            kind: "full_sync",
            status: "failed",
            attempts: 3,
            payload: { reason: "manual" },
            report: null,
            error: "ЕИС не ответила: хранилище файлов недоступно с этого адреса",
            finished_at: null,
          }),
        ],
      }),
    );
    render(<WorkerQueuePanel />);
    await settled();

    expect(screen.getByText("Плановый прогон")).toBeTruthy();
    expect(screen.getByText("панель администратора")).toBeTruthy();
    expect(screen.getByText(/Не выполнено · попытка 3/)).toBeTruthy();
    expect(
      screen.getByText("ЕИС не ответила: хранилище файлов недоступно с этого адреса"),
    ).toBeTruthy();
    // Плановый прогон не привязан к номерам закупок: счётчик «закупок» для него
    // был бы выдуманной цифрой, поэтому в этой колонке прочерк.
    const row = screen.getByRole("row", { name: /Плановый прогон/ });
    expect(within(row).getAllByRole("cell")[3]?.textContent).toBe("—");
  });

  it("неизвестная причина показывается как пришла из базы", async () => {
    mockStatus(
      statusResponse({
        recent: [job({ id: "job-3", payload: { regNumbers: [], reason: "retry-after-vps-move" } })],
      }),
    );
    render(<WorkerQueuePanel />);
    await settled();

    expect(screen.getByText("retry-after-vps-move")).toBeTruthy();
  });

  it("смета с присланными файлами: журнал не показывает их содержимое", async () => {
    // Документация закупки часто идёт под NDA, а журнал открыт всей панели.
    // Тексты уезжают на сервер вместе с заданием сметы, потому что хранить их
    // больше негде, — значит именно здесь их нельзя ни отдавать, ни печатать.
    const estimate = job({
      id: "job-4",
      kind: "estimate",
      payload: {
        tenderId: "t-1",
        subject: "Строительство административно-бытового корпуса",
        documents: [
          { name: "ЛСР 02-01-02 Конструкции металлические.csv", text: "1 Разработка грунта вручную | м3 | 850" },
        ],
      },
    });
    mockStatus(statusResponse({ recent: [estimate], lastJob: estimate }));
    const { container } = render(<WorkerQueuePanel />);
    await settled();

    expect(screen.getAllByText("Расчёт сметы").length).toBeGreaterThan(0);
    expect(container.textContent ?? "").not.toContain("Разработка грунта");
  });
});
