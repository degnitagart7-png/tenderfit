import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { LOGO_MARK } from "@/components/brand/LogoMark";

/**
 * Картинка превью ссылки на сайт — её показывают Telegram, ВКонтакте, WhatsApp.
 *
 * Без неё мессенджер рисует голый адрес или случайный кусок страницы. Текст
 * набирается Inter из репозитория (src/assets/fonts): встроенный шрифт генератора
 * знает только латиницу, и «ТендерФит» вышел бы квадратиками. Шрифт читается с
 * диска, а не из сети: сборка и сервер не должны зависеть от Google Fonts.
 */

export const alt = "ТендерФит — какие закупки ваши и почему";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#1A1816";
const PAPER = "#F6F6F4";
const MUTED = "#6B6660";

async function font(file: string): Promise<ArrayBuffer> {
  const bytes = await readFile(join(process.cwd(), "src/assets/fonts", file));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export default async function OpenGraphImage() {
  const [bold, medium] = await Promise.all([font("Inter-Bold.ttf"), font("Inter-Medium.ttf")]);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: PAPER,
          fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <svg width="112" height="112" viewBox="6 6 88 88">
            <rect x="6" y="6" width="88" height="88" rx="22" fill={LOGO_MARK.color} />
            <path
              d={LOGO_MARK.path}
              fill="none"
              stroke="#fff"
              strokeWidth={LOGO_MARK.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div style={{ display: "flex", fontSize: 76, fontWeight: 700, letterSpacing: -2, color: INK }}>
            Тендер<span style={{ color: LOGO_MARK.color }}>Фит</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", fontSize: 58, fontWeight: 700, lineHeight: 1.12, letterSpacing: -1.5, color: INK }}>
            Какие закупки ваши — и почему
          </div>
          <div style={{ display: "flex", fontSize: 30, fontWeight: 500, color: MUTED }}>
            Анализ закупок 44-ФЗ и 223-ФЗ · tender-fit.ru
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Inter", data: bold, weight: 700, style: "normal" },
        { name: "Inter", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
