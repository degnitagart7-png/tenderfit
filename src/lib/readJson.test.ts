import { describe, expect, it } from "vitest";

import { readJsonOrThrow } from "@/lib/readJson";

function response(
  body: string,
  init: { status?: number; contentType?: string } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "Content-Type": init.contentType ?? "application/json" },
  });
}

/**
 * Разбор ответа: сначала код, потом тело.
 *
 * Неудача приходит не JSON'ом. Маршрут, которого нет, отдаёт страницу 404
 * целиком; шлюз и обратный прокси — свою страницу ошибки; упавший процесс —
 * пустое тело. Разбор такого ответа падает первым, и наверх уходит «Unexpected
 * token <» вместо «HTTP 502» — то есть теряется ровно та часть, по которой
 * чинят.
 *
 * Но и сообщение из тела бросать нельзя: наши роуты кладут в JSON поле `error`
 * с человеческой причиной («Очередь заданий не настроена…»), и заменять её
 * кодом было бы шагом назад. Поэтому порядок такой: код проверяется первым,
 * тело читается как текст, а разобрать его как JSON — попытка, а не условие.
 */
describe("readJsonOrThrow", () => {
  it("успешный ответ разбирается", async () => {
    await expect(readJsonOrThrow<{ a: number }>(response('{"a":1}'))).resolves.toEqual({
      a: 1,
    });
  });

  it("ошибка с JSON-телом: наверх идёт причина из поля error", async () => {
    await expect(
      readJsonOrThrow(response('{"error":"Очередь заданий не настроена"}', { status: 503 })),
    ).rejects.toThrow("Очередь заданий не настроена");
  });

  it("ошибка со страницей HTML: наверх идёт код, а не «Unexpected token»", async () => {
    const promise = readJsonOrThrow(
      response("<!doctype html><title>404</title>", {
        status: 404,
        contentType: "text/html",
      }),
    );

    await expect(promise).rejects.toThrow(/HTTP 404/);
  });

  it("ошибка с пустым телом: код всё равно назван", async () => {
    await expect(readJsonOrThrow(response("", { status: 502 }))).rejects.toThrow(/HTTP 502/);
  });

  it("успешный ответ с неразбираемым телом: это тоже ошибка, но с кодом", async () => {
    await expect(
      readJsonOrThrow(response("не json", { status: 200 })),
    ).rejects.toThrow(/HTTP 200/);
  });

  it("длинная страница ошибки в сообщение не вставляется целиком", async () => {
    const error = await readJsonOrThrow(
      response("<html>" + "и".repeat(5000) + "</html>", {
        status: 500,
        contentType: "text/html",
      }),
    ).catch((thrown: unknown) => thrown);

    expect(String(error).length).toBeLessThan(400);
  });
});
