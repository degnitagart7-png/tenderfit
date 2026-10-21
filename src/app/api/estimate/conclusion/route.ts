import { requireAccess } from "@/app/api/auth/requireAccess";
import { recordRequestEvent } from "@/app/api/auth/requestUser";
import { NextRequest, NextResponse } from "next/server";

import { estimateViewer } from "@/app/api/estimate/viewer";
import type { AuditReport } from "@/domain/estimate/customerAudit";
import { canReadEstimateJob } from "@/domain/estimate/jobOwnership";
import { describeError } from "@/lib/errors";
import { syncJobRepository } from "@/repositories/syncJobRepository";
import { tenderRepository } from "@/repositories/tenderRepository";
import { auditOverallFileName } from "@/domain/estimate/auditConclusionReport";
import { estimateTitle } from "@/domain/estimate/auditEstimateTitle";
import { auditConclusionFileName, buildAuditConclusionDocx, buildAuditOverallDocx } from "@/services/auditConclusionExport";

/**
 * GET /api/estimate/conclusion?jobId=…&report=0 — «Заключение по смете заказчика» файлом Word.
 *
 * Берёт готовый результат проверки (`mode: "audit"`) из задания и собирает документ: вывод, причины разницы, позиции,
 * непереоценённое, методика, оговорки. Файл строится на сервере: результат лежит в базе, а сборка .docx — это библиотека
 * на мегабайт, которой нечего делать в браузерном пакете.
 *
 * Доступ — как у `GET /api/estimate?jobId=`: вошедший получает только свои проверки, администратор и служебный запрос — любую.
 * Чужое задание и несуществующее неразличимы: один и тот же 404, чтобы по ответу нельзя было узнать, чей номер угадан.
 *
 * `report` — номер сметы в проверке (их бывает несколько); по умолчанию первая. `report=all` — одно заключение по всем сметам:
 * итог, таблица смет и разделы по каждой.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Объект и номер закупки для шапки. Предмет — из самой закупки (`subject` задания бывает номером закупки: так его передаёт
 * экран, когда у закупки нет названия); нет закупки в базе или база не отвечает — берётся то, что записано в задании.
 */
async function objectOf(tenderId: string | null, jobSubject: string | null): Promise<{ subject: string | null; regNumber: string | null }> {
  const looksLikeNumber = (text: string | null): boolean => text === null || text.trim() === "" || /^[\d\s-]{8,}$/.test(text.trim());
  let subject = looksLikeNumber(jobSubject) ? null : jobSubject;
  let regNumber = tenderId;
  if (tenderId !== null && subject === null) {
    try {
      const row = (await tenderRepository.findById(tenderId)) ?? (await tenderRepository.findByRegNumber(tenderId));
      if (row !== null) {
        subject = row.subject.trim() === "" ? null : row.subject;
        regNumber = row.reg_number;
      }
    } catch {
      // Шапка без предмета лучше, чем без файла.
    }
  }
  return { subject, regNumber };
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Проверка не найдена: такого номера нет, или она сделана другим пользователем." }, { status: 404 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  const jobId = request.nextUrl.searchParams.get("jobId")?.trim() ?? "";
  if (jobId === "") return NextResponse.json({ error: "Нужен jobId" }, { status: 400 });
  const rawReport = request.nextUrl.searchParams.get("report") ?? "0";
  const wantAll = rawReport === "all";
  const reportParam = Number.parseInt(rawReport, 10);
  const reportIndex = Number.isFinite(reportParam) && reportParam >= 0 ? reportParam : 0;

  try {
    const viewer = estimateViewer(request);
    const job = await syncJobRepository.findById(jobId);
    // Чужое, не расчёт сметы и не проверка — как будто такого нет.
    if (job === null || job.kind !== "estimate" || (job.payload?.mode ?? "estimate") !== "audit" || !canReadEstimateJob(viewer, job.requested_by)) {
      return notFound();
    }
    if (job.status !== "completed") {
      return NextResponse.json({ error: "Проверка ещё не закончена: заключение появится, когда она будет готова." }, { status: 409 });
    }
    const audit = job.report?.audit;
    const report = audit?.reports[wantAll ? 0 : reportIndex] as AuditReport | undefined;
    if (audit === undefined || report === undefined) {
      return NextResponse.json({ error: "В этой проверке нет сметы, по которой можно составить заключение." }, { status: 409 });
    }

    const generatedAt = new Date();
    const object = await objectOf(job.payload?.tenderId ?? null, job.payload?.subject ?? null);
    const fileNames = job.payload?.documentNames ?? job.payload?.documents?.map((item) => item.name) ?? [];
    const send = (bytes: Uint8Array, fileName: string): NextResponse => {
      recordRequestEvent(request, { kind: "estimate", tenderId: job.payload?.tenderId ?? null, detail: "заключение по смете заказчика (Word)" });
      return new NextResponse(Buffer.from(bytes), {
        status: 200,
        headers: {
          "Content-Type": DOCX_TYPE,
          // Имя на русском: ASCII-запасное для старых клиентов и полное по RFC 5987.
          "Content-Disposition": `attachment; filename="conclusion.docx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Cache-Control": "private, no-store",
        },
      });
    };
    if (wantAll) {
      const bytes = await buildAuditOverallDocx({
        reports: audit.reports as AuditReport[],
        notRecognized: audit.notRecognized,
        subject: object.subject,
        tenderId: object.regNumber,
        fileNames,
        generatedAt,
      });
      return send(bytes, auditOverallFileName(generatedAt));
    }
    const bytes = await buildAuditConclusionDocx({
      report,
      notRecognized: audit.notRecognized,
      subject: object.subject,
      tenderId: object.regNumber,
      fileNames,
      generatedAt,
    });
    const fileName = auditConclusionFileName(estimateTitle(report), generatedAt);
    return send(bytes, fileName);
  } catch (error) {
    recordRequestEvent(request, { kind: "error", ok: false, detail: `GET /api/estimate/conclusion: ${describeError(error)}` });
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}
