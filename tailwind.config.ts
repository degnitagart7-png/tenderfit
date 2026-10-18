import type { Config } from "tailwindcss";

/**
 * Светлая тема ТендерФит.
 *
 * Цвета читаются из CSS-переменных (globals.css), заданных тройками RGB —
 * поэтому работают модификаторы прозрачности.
 *
 * Палитра по мотивам дашборда Orbit CRM: тёплая почти-белая подложка, белые
 * поверхности с тонкой тёплой границей, крупный радиус, кнопки-пилюли и один
 * оранжевый акцент. Имена токенов намеренно оставлены прежними (accent, olive,
 * mustard, brick): смысл у них тот же, поменялись только значения, и весь код
 * приложения переехал на новую палитру без правок разметки.
 */
const rgb = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: rgb("background"),
        panel: rgb("panel"),
        "panel-raised": rgb("panel-raised"),
        sidebar: rgb("sidebar"),
        border: rgb("border"),
        "border-strong": rgb("border-strong"),
        foreground: rgb("foreground"),
        "ink-soft": rgb("ink-soft"),
        "muted-foreground": rgb("muted-foreground"),
        faint: rgb("faint"),
        // Тёмная тёплая заливка: чекбоксы, панель массового действия, тултипы.
        ink: rgb("ink"),

        // Бренд / CTA — тёплый оранжевый, дозированно.
        // strong — заливка кнопок (белый текст, AA), fg — мелкий текст и ссылки.
        accent: {
          DEFAULT: rgb("accent"),
          strong: rgb("accent-strong"),
          hover: rgb("accent-hover"),
          subtle: rgb("accent-subtle"),
          line: rgb("accent-line"),
          fg: rgb("accent-fg"),
        },
        // Ручная проверка — золото (не оранжевый: он занят акцентом).
        mustard: {
          DEFAULT: rgb("mustard"),
          fg: rgb("mustard-fg"),
          subtle: rgb("mustard-subtle"),
          line: rgb("mustard-line"),
        },
        // Рекомендовано — success.
        olive: {
          DEFAULT: rgb("olive"),
          fg: rgb("olive-fg"),
          subtle: rgb("olive-subtle"),
          line: rgb("olive-line"),
        },
        // Риск / отклонено — danger.
        brick: {
          DEFAULT: rgb("brick"),
          fg: rgb("brick-fg"),
          subtle: rgb("brick-subtle"),
          line: rgb("brick-line"),
        },

        // Совместимость со старыми классами brand-*.
        brand: {
          50: "rgb(var(--accent) / 0.08)",
          100: "rgb(var(--accent) / 0.14)",
          200: "rgb(var(--accent) / 0.28)",
          300: "rgb(var(--accent) / 0.45)",
          400: "rgb(var(--accent-fg) / 0.8)",
          500: rgb("accent"),
          600: rgb("accent-strong"),
          700: rgb("accent-fg"),
          800: rgb("accent-fg"),
          900: rgb("accent-fg"),
        },
      },
      fontFamily: {
        // Заголовки — чистый гротеск. Inter, а не модный геометрический
        // гротеск с Dribbble: у большинства из них нет кириллицы, а половина
        // интерфейса здесь — русский текст.
        display: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        // Данные: числа, даты, ИНН, номера закупок.
        mono: [
          "JetBrains Mono",
          "IBM Plex Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      borderRadius: {
        // Мягкая геометрия референса: карточка заметно круглее, чем была (14px),
        // элемент управления — 10px, кнопка — пилюля.
        card: "16px",
        control: "10px",
        pill: "999px",
      },
      boxShadow: {
        card: "var(--card-shadow)",
        "card-hover": "var(--card-shadow-hover)",
        // Активный пункт меню и приподнятые пилюли.
        pill: "var(--pill-shadow)",
      },
    },
  },
  plugins: [],
};

export default config;
