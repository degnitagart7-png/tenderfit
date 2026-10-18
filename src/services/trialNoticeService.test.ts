import { describe, expect, it, vi } from "vitest";

import type { TrialNoticeCandidate } from "@/domain/trialNotices";
import { runTrialNotices, type TrialNoticeDeps } from "@/services/trialNoticeService";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const H = 3_600_000;

const cand = (id: string, email: string, trialEndsAt: number, over: Partial<TrialNoticeCandidate> = {}): TrialNoticeCandidate => ({
  id,
  email,
  trialEndsAt,
  paidUntil: null,
  noticeSentAt: null,
  endNoticeSentAt: null,
  ...over,
});

function setup(candidates: TrialNoticeCandidate[], over: Partial<TrialNoticeDeps> = {}) {
  const claimed = new Set<string>();
  const deps: TrialNoticeDeps = {
    env: {},
    now: () => NOW,
    smtpConfigured: () => true,
    listCandidates: vi.fn(async () => candidates),
    claim: vi.fn(async (id: string, kind: string) => {
      const key = `${id}:${kind}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
    release: vi.fn(async (id: string, kind: string) => void claimed.delete(`${id}:${kind}`)),
    sendMail: vi.fn(async () => undefined),
    log: vi.fn(),
    ...over,
  };
  return { deps, claimed };
}

describe("runTrialNotices", () => {
  it("за сутки — письмо с темой и ссылкой на оплату; закончился — своё письмо", async () => {
    const { deps } = setup([cand("a", "a@firma.ru", NOW + 5 * H), cand("b", "b@firma.ru", NOW - H)]);

    const result = await runTrialNotices(deps);

    expect(result.sent).toEqual({ ending: 1, ended: 1 });
    const calls = vi.mocked(deps.sendMail).mock.calls;
    expect(calls[0]?.[0]).toBe("a@firma.ru");
    expect(calls[0]?.[1]).toBe("Пробный период закончится завтра");
    expect(calls[0]?.[2]).toContain("https://tender-fit.ru/billing");
    expect(calls[0]?.[3]).toContain("<!doctype html>");
    expect(calls[1]?.[1]).toBe("Пробный период закончился");
  });

  it("повторная проверка тех же людей писем не шлёт: отметка занята", async () => {
    const { deps } = setup([cand("a", "a@firma.ru", NOW + 5 * H)]);

    await runTrialNotices(deps);
    const second = await runTrialNotices(deps);

    expect(second.sent).toEqual({ ending: 0, ended: 0 });
    expect(deps.sendMail).toHaveBeenCalledTimes(1);
  });

  it("сбой почты: отметка снята, следующая проверка повторит, наружу ничего не летит", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("SMTP недоступен")).mockResolvedValue(undefined);
    const { deps } = setup([cand("a", "a@firma.ru", NOW + 5 * H)], { sendMail: send });

    const first = await runTrialNotices(deps);
    const second = await runTrialNotices(deps);

    expect(first.failed).toBe(1);
    expect(second.sent.ending).toBe(1);
  });

  it("почта не настроена — пропуск без обращения к базе", async () => {
    const { deps } = setup([cand("a", "a@firma.ru", NOW + 5 * H)], { smtpConfigured: () => false });

    const result = await runTrialNotices(deps);

    expect(result.skipped).toBe(true);
    expect(deps.listCandidates).not.toHaveBeenCalled();
  });

  it("сбой базы не бросается наружу", async () => {
    const { deps } = setup([], { listCandidates: vi.fn(async () => { throw new Error("база недоступна"); }) });

    await expect(runTrialNotices(deps)).resolves.toMatchObject({ failed: 0 });
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/база недоступна/));
  });

  it("администраторам из ADMIN_EMAILS письма не уходят", async () => {
    const { deps } = setup([cand("a", "Owner@Firma.ru", NOW + 5 * H)], { env: { ADMIN_EMAILS: "owner@firma.ru" } });

    await runTrialNotices(deps);

    expect(deps.sendMail).not.toHaveBeenCalled();
  });
});
