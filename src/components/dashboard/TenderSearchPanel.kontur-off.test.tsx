import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TenderSearchPanel } from "@/components/dashboard/TenderSearchPanel";

vi.mock("@/services/konturApiService", () => ({
  konturApiService: { getUsage: vi.fn(), sync: vi.fn() },
}));
vi.mock("@/services/syncJobApiService", () => ({
  syncJobApiService: { getStatus: vi.fn(), enqueueFullSync: vi.fn() },
}));

import { konturApiService } from "@/services/konturApiService";
import { syncJobApiService } from "@/services/syncJobApiService";

/**
 * Контур.Закупки отключены (KONTUR_ENABLED = false), выключатель здесь настоящий.
 *
 * Строка «Остаток лимита (бесплатно)» в журнале появилась оттого, что панель при
 * открытии спрашивала Контур. Теперь панель не должна ни спрашивать его, ни
 * предлагать его платный поиск, а бесплатный прогон площадок остаётся.
 */

function renderPanel() {
  const Wrapper = () => (
    <TenderSearchPanel
      open
      onOpenChange={() => undefined}
      syncKontur={vi.fn()}
      syncState={{ syncing: false, error: null, lastSynced: 0, progress: null, report: null }}
    />
  );
  render(<Wrapper />);
}

beforeEach(() => {
  vi.mocked(syncJobApiService.getStatus).mockResolvedValue({
    view: { state: "online", label: "Сервер на связи", hint: "Принимает задания." },
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TenderSearchPanel при выключенном Контуре", () => {
  it("не спрашивает у Контура остаток лимита при открытии", async () => {
    renderPanel();

    await waitFor(() => expect(syncJobApiService.getStatus).toHaveBeenCalled());

    expect(konturApiService.getUsage).not.toHaveBeenCalled();
  });

  it("не предлагает платный поиск Контура", async () => {
    renderPanel();
    await waitFor(() => expect(syncJobApiService.getStatus).toHaveBeenCalled());

    expect(screen.queryByText(/контур/i)).toBeNull();
  });

  it("бесплатный прогон площадок на месте", async () => {
    renderPanel();
    await waitFor(() => expect(syncJobApiService.getStatus).toHaveBeenCalled());

    expect(screen.getByText("Поиск на площадках")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Запустить поиск" })).toBeTruthy();
  });
});
