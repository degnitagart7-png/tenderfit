import { requireAccess } from "@/app/api/auth/requireAccess";
import { recordRequestEvent, requestEmail } from "@/app/api/auth/requestUser";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { parseTenderLink } from "@/domain/tenderLink";
import { describeError } from "@/lib/errors";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import { tenderRepository } from "@/repositories/tenderRepository";
import type { SyncJobRow } from "@/types/database";

/**
 * Добавить закупку по ссылке ЕИС или номеру.
 *
 * POST { link } — распознать номер и поставить задание; GET ?jobId= — как оно идёт.
 *
 * Зачем. Добавлять закупку вручную (номер, предмет, НМЦК, сроки) или CSV никто
 * не хочет, а документация закупок — doc, pdf, xlsx, не CSV (замечание владельца
 * 13.10.2026). По ссылке сервер сам находит закупку в ЕИС, скачивает
 * документацию и запускает глубокий анализ: задание «документация» с пометкой
 * `importFromLink` выполняет воркер на российском адресе (ЕИС отвечает только
 * ему), разбор оплачен тем, что человек сам попросил эту закупку.
 */
export const runtime = "nodejs";

const bodySchema = z.object({ link: z.string().max(2000) });
const jobIdSchema = z.string().uuid();

function view(job: SyncJobRow, regNumber: string, tenderReady: boolean) {
  return {
    jobId: job.id,
    regNumber,
    status: job.status,
    note: job.report?.note ?? null,
    error: job.error ?? null,
    /** Закупка уже в базе: карточку можно открыть, документы и анализ дойдут следом. */
    tenderReady,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) return NextResponse.json({ error: "Вставьте ссылку или номер закупки." }, { status: 400 });

  const link = parseTenderLink(parsedBody.data.link);
  if (!link.ok) return NextResponse.json({ error: link.error }, { status: 400 });

  try {
    // Повторное нажатие не плодит задания: идущее по тому же номеру — возвращаем его.
    const active = (await syncJobRepository.findRecent(20)).find(
      (job) =>
        job.kind === "documents" &&
        (job.status === "pending" || job.status === "processing") &&
        job.payload?.importFromLink === true &&
        (job.payload.regNumbers ?? []).includes(link.regNumber),
    );
    const job =
      active ??
      (await syncJobRepository.create(
        "documents",
        {
          regNumbers: [link.regNumber],
          reason: "link",
          analyze: true,
          importFromLink: true,
        },
        // Задание записывается на вошедшего: его сбой виден в /admin/users.
        requestEmail(request),
      ));
    if (!active) recordRequestEvent(request, { kind: "link_import", tenderId: link.regNumber });
    const stored = await tenderRepository.findByRegNumber(link.regNumber);
    return NextResponse.json(view(job, link.regNumber, stored !== null), { status: active ? 200 : 201 });
  } catch (error) {
    console.error("Добавление по ссылке: задание не поставлено:", describeError(error));
    recordRequestEvent(request, { kind: "error", ok: false, tenderId: link.regNumber, detail: `POST /api/tenders/link: ${describeError(error)}` });
    return NextResponse.json({ error: "Сейчас не получилось поставить задание. Попробуйте через минуту." }, { status: 503 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  const jobId = jobIdSchema.safeParse(request.nextUrl.searchParams.get("jobId"));
  if (!jobId.success) return NextResponse.json({ error: "Нет номера задания." }, { status: 400 });

  try {
    const job = await syncJobRepository.findById(jobId.data);
    if (job === null || job.payload?.importFromLink !== true) {
      return NextResponse.json({ error: "Задание не найдено." }, { status: 404 });
    }
    const regNumber = job.payload.regNumbers?.[0] ?? "";
    const stored = regNumber === "" ? null : await tenderRepository.findByRegNumber(regNumber);
    return NextResponse.json(view(job, regNumber, stored !== null));
  } catch (error) {
    console.error("Добавление по ссылке: состояние не прочитано:", describeError(error));
    return NextResponse.json({ error: "Состояние задания сейчас не читается." }, { status: 503 });
  }
}
