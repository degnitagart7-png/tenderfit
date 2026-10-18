"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";

import { Button } from "@/components/ui/primitives";
import { pipelineRepository } from "@/repositories/pipelineRepository";
import { tenderApiService } from "@/services/tenderApiService";

/**
 * «Вставьте ссылку на закупку»: добавление закупки без ручного заполнения.
 *
 * Человек вставляет ссылку из ЕИС или реестровый номер — сервер сам находит
 * закупку, скачивает документацию и запускает глубокий анализ (`/api/tenders/link`).
 * Как только закупка в базе, её можно открыть; когда задание закончено, карточка
 * открывается сама. Добавленная закупка сразу попадает в «Мои закупки» как
 * «Интересное»: раз человек принёс её сам, она ему нужна.
 */

type Phase = "idle" | "sending" | "working" | "done" | "error";

interface LinkJobView {
  jobId: string;
  regNumber: string;
  status: "pending" | "processing" | "completed" | "failed";
  note: string | null;
  error: string | null;
  tenderReady: boolean;
}

const POLL_MS = 4000;
/** Дольше не ждём у экрана: документация и анализ идут минуты, но не десятки. */
const MAX_WAIT_MS = 15 * 60_000;

async function readJson(response: Response): Promise<LinkJobView & { error?: string | null }> {
  return (await response.json().catch(() => ({}))) as LinkJobView & { error?: string | null };
}

export function AddTenderByLink({ pollMs = POLL_MS }: { pollMs?: number }) {
  const router = useRouter();
  const [link, setLink] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [job, setJob] = useState<LinkJobView | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const open = (regNumber: string): void => {
    pipelineRepository.setStatus(regNumber, "INTERESTING");
    tenderApiService.invalidateFeed();
    router.push(`/tenders/${encodeURIComponent(regNumber)}`);
  };

  const submit = async (): Promise<void> => {
    setPhase("sending");
    setMessage(null);
    setJob(null);
    try {
      const response = await fetch("/api/tenders/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link }),
      });
      const started = await readJson(response);
      if (!response.ok) {
        setPhase("error");
        setMessage(started.error ?? "Не получилось добавить закупку.");
        return;
      }
      setJob(started);
      setPhase("working");

      const deadline = Date.now() + MAX_WAIT_MS;
      let current = started;
      while (!cancelled.current && current.status !== "completed" && current.status !== "failed") {
        if (Date.now() > deadline) {
          setPhase("done");
          setMessage("Загрузка идёт дольше обычного — закупка появится в ленте, когда сервер закончит.");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (cancelled.current) return;
        const polled = await fetch(`/api/tenders/link?jobId=${encodeURIComponent(started.jobId)}`);
        if (!polled.ok) continue;
        current = await readJson(polled);
        setJob(current);
      }
      if (cancelled.current) return;

      if (current.status === "failed") {
        setPhase("error");
        setMessage(current.error ?? "Сервер не смог загрузить закупку. Попробуйте ещё раз позже.");
        return;
      }
      if (current.tenderReady) {
        setPhase("done");
        open(current.regNumber);
        return;
      }
      setPhase("error");
      setMessage(current.note ?? "Закупку с этим номером в ЕИС найти не удалось.");
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const busy = phase === "sending" || phase === "working";
  const progress =
    job === null
      ? "Проверяю ссылку…"
      : job.status === "pending"
        ? `Закупка ${job.regNumber}: задание в очереди, сервер возьмёт его через несколько секунд…`
        : `Закупка ${job.regNumber}: ищу в ЕИС, скачиваю документацию и запускаю анализ…`;

  return (
    <div className="card space-y-3 p-5" data-testid="add-tender-by-link">
      <div>
        <h2 className="text-[17px] font-semibold text-foreground">Добавить по ссылке</h2>
        <p className="mt-1 text-[14.5px] text-muted-foreground">
          Вставьте ссылку на закупку из ЕИС (zakupki.gov.ru) или её реестровый номер. Мы сами найдём закупку,
          скачаем документацию (doc, pdf, xlsx, архивы) и запустим анализ — заполнять ничего не нужно.
        </p>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && link.trim() !== "") void submit();
        }}
      >
        <label className="sr-only" htmlFor="tender-link">
          Ссылка или номер закупки
        </label>
        <div className="relative flex-1">
          <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            id="tender-link"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://zakupki.gov.ru/epz/order/notice/…?regNumber=… или 0302300083426000012"
            className="h-11 w-full rounded-[10px] border border-border bg-panel pl-9 pr-3 text-[15px] text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
            disabled={busy}
            inputMode="url"
            autoComplete="off"
          />
        </div>
        <Button type="submit" loading={busy} disabled={busy || link.trim() === ""}>
          {busy ? "Добавляю…" : "Добавить"}
        </Button>
      </form>

      {busy && (
        <p className="text-[14px] text-muted-foreground" role="status">
          {progress}
          {job?.tenderReady === true && (
            <>
              {" "}
              <Link
                href={`/tenders/${encodeURIComponent(job.regNumber)}`}
                className="font-medium text-accent underline underline-offset-2"
                onClick={() => pipelineRepository.setStatus(job.regNumber, "INTERESTING")}
              >
                Закупка уже в базе — открыть карточку
              </Link>
            </>
          )}
        </p>
      )}
      {phase === "error" && message !== null && (
        <p className="text-[14px] text-brick-fg" role="alert">
          {message}
        </p>
      )}
      {phase === "done" && message !== null && (
        <p className="text-[14px] text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
