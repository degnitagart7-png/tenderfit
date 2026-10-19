import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { MAX_UPLOAD_BYTES } from "@/domain/documentUpload";
import { requireAccess } from "@/app/api/auth/requireAccess";
import { createAssistLimiter } from "@/app/api/search/guard";
import { describeError } from "@/lib/errors";
import { clientKey } from "@/lib/rateLimit";
import { makeTempDir } from "@/services/archiveCli";
import { parseAttachmentFile } from "@/services/attachmentParser";

/**
 * POST /api/documents/parse — серверный разбор одного файла для экрана «Смета».
 *
 * Зачем. Браузерный разбор (documentParser.parseDocument) не читает старые
 * бинарные .doc и архивы. Между тем документы закупок Сбербанк-АСТ, Фабриканта и
 * ЭТП ГПБ робот не скачивает — человек берёт их на площадке, и чаще всего это
 * архив. Серверный разбор (attachmentParser) читает и .doc, и zip/rar/7z с
 * вложенными архивами; здесь он открыт загрузке с экрана.
 *
 * Вход: multipart/form-data, поле `file` — один файл до 50 МБ (MAX_UPLOAD_BYTES,
 * меньше client_max_body_size nginx в 64 МБ с запасом на обвязку multipart). Файл за раз, а не
 * пачкой: экран шлёт их по очереди и показывает каждому свой результат.
 *
 * Ответ 200: `{ status, text, reason, archive, truncated }` — как у
 * `ParsedAttachment`. Нечитаемый файл — это тоже 200 со `status` не «parsed» и
 * причиной в `reason`: ошибка запроса и «файл не читается» — разные вещи, и
 * экрану нужно показать причину именно этого файла. Ошибки запроса: 400 — нет
 * файла или он пуст, 413 — больше предела, 429 — слишком часто, 401/402/503 — от
 * requireAccess.
 *
 * Распознавание сканов ВЫКЛЮЧЕНО (`ocr: null`): Tesseract читает страницу за
 * секунды, а скан на сорок страниц держал бы запрос минутами. Сканы внутри
 * архива попадают в `archive.skipped` с причиной, и экран их так и показывает.
 *
 * Файл пишется во временный каталог и читается оттуда общим дисковым путём
 * (`parseAttachmentFile`, как у загрузчика вложений): крупные архивы
 * распаковываются программами 7z/unrar на диск, а не в память процесса. Каталог
 * убирается при любом исходе. Содержимое файлов в журнал не пишется — только
 * причина сбоя.
 *
 * Пределы тела. Next 14 не ограничивает тело обработчика маршрута (1 МБ — это
 * предел server actions) и не копирует его в middleware (matcher не охватывает
 * /api). Выше стоит nginx: `client_max_body_size 64m` (deploy/nginx-tenderfit.conf),
 * поэтому предел 50 МБ здесь срабатывает раньше и отвечает внятной ошибкой, а не
 * голым 413 от nginx.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Бюджет знаков на один файл. Задание сметы принимает до 2 000 000 знаков на все
 * документы (MAX_TOTAL_CHARS в /api/estimate), и один файл не должен занимать
 * его целиком: остальным документам тоже нужно место.
 */
const PARSE_BUDGET_CHARS = 1_500_000;

/** Обвязка multipart: границы и заголовки части. Для предварительной проверки Content-Length. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** Разбор — это CPU и диск: тридцать файлов за десять минут с адреса человеку хватает с запасом. */
const limiter = createAssistLimiter(30);

/** Имя файла в ответе и в разборе: без путей и управляющих символов, не длиннее 255 знаков. */
function safeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f]/g, " ").split(/[\\/]/).pop()?.trim() ?? "";
  return (flat === "" ? "document" : flat).slice(-255);
}

function tooLarge(): NextResponse {
  return NextResponse.json(
    { error: `Файл больше ${String(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ: разделите архив или загрузите нужные файлы отдельно.` },
    { status: 413 },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requireAccess(request);
  if (denied) return denied;

  const decision = limiter.check(clientKey(request.headers));
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Слишком много файлов за короткое время. Подождите немного.", retryAfterSec: decision.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSec) } },
    );
  }

  // Отказ по заголовку, пока тело не прочитано: пятьсот мегабайт в память не берём.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) return tooLarge();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Ожидается multipart/form-data с полем file" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Не передан файл (поле file)" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "Файл пуст" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) return tooLarge();

  const filename = safeName(file.name);
  const work = await makeTempDir("tenderfit-upload-");
  try {
    // Имя на диске фиксированное: настоящее имя (расширение, подпись) идёт в разбор отдельным аргументом.
    const path = join(work.dir, "upload.bin");
    await writeFile(path, new Uint8Array(await file.arrayBuffer()));

    const parsed = await parseAttachmentFile(path, filename, file.type === "" ? null : file.type, PARSE_BUDGET_CHARS, {
      ocr: null,
    });

    return NextResponse.json({
      status: parsed.status,
      text: parsed.text,
      reason: parsed.reason,
      archive: parsed.archive ?? null,
      truncated: parsed.truncated,
    });
  } catch (error) {
    // Только причина сбоя: ни имя, ни содержимое файла в журнал не идут.
    console.error("Разбор загруженного файла не удался:", describeError(error));
    return NextResponse.json({ error: "Не удалось разобрать файл на сервере. Попробуйте позже." }, { status: 500 });
  } finally {
    await work.dispose();
  }
}
