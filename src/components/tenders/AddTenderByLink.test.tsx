import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { AddTenderByLink } from "@/components/tenders/AddTenderByLink";
import { pipelineRepository } from "@/repositories/pipelineRepository";

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("AddTenderByLink", () => {
  beforeEach(() => {
    push.mockReset();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ссылка → задание → закупка готова: карточка открывается сама и попадает в «Интересное»", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        respond({ jobId: "11111111-1111-4111-8111-111111111111", regNumber: "0302300083426000012", status: "pending", note: null, error: null, tenderReady: false }, 201),
      )
      .mockResolvedValueOnce(
        respond({ jobId: "11111111-1111-4111-8111-111111111111", regNumber: "0302300083426000012", status: "completed", note: null, error: null, tenderReady: true }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<AddTenderByLink pollMs={1} />);
    fireEvent.change(screen.getByLabelText("Ссылка или номер закупки"), {
      target: { value: "https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0302300083426000012" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Добавить/ }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/tenders/0302300083426000012"));
    expect(pipelineRepository.getStatus("0302300083426000012")).toBe("INTERESTING");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/tenders/link");
  });

  it("сервер не распознал ссылку — его объяснение видно человеку", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ error: "Не нашёл номер закупки." }, 400)));

    render(<AddTenderByLink pollMs={1} />);
    fireEvent.change(screen.getByLabelText("Ссылка или номер закупки"), { target: { value: "кровля" } });
    fireEvent.click(screen.getByRole("button", { name: /Добавить/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Не нашёл номер закупки.");
    expect(push).not.toHaveBeenCalled();
  });

  it("в ЕИС закупку не нашли — показывается заметка задания, карточка не открывается", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(respond({ jobId: "j", regNumber: "32616400001", status: "pending", note: null, error: null, tenderReady: false }, 201))
        .mockResolvedValueOnce(
          respond({ jobId: "j", regNumber: "32616400001", status: "completed", note: "в ЕИС не найдено: 32616400001", error: null, tenderReady: false }),
        ),
    );

    render(<AddTenderByLink pollMs={1} />);
    fireEvent.change(screen.getByLabelText("Ссылка или номер закупки"), { target: { value: "32616400001" } });
    fireEvent.click(screen.getByRole("button", { name: /Добавить/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("в ЕИС не найдено");
    expect(push).not.toHaveBeenCalled();
  });
});
