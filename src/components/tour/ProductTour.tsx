"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/primitives";

/**
 * Короткий тур по продукту: шесть шагов, по одному на главную функцию.
 *
 * Анкета при регистрации сжата до двух вопросов (16.10.2026), и то, что раньше
 * человек узнавал из восьми шагов мастера, — где поиск, где анализ, где смета, —
 * теперь показывается прямо на экране: затемнение с вырезом вокруг элемента и
 * карточка рядом. Без зависимостей: вырез — прямоугольник с огромной тенью,
 * координаты — `getBoundingClientRect`, пересчёт на прокрутку и смену размера.
 *
 * Цель шага ищется по `data-tour="<id>"`. Нет элемента или он не виден (пункт
 * меню в свёрнутом мобильном меню, анализ — в карточке закупки, а не в ленте) —
 * шаг показывается карточкой по центру: рассказать всё равно нужно.
 */

export interface TourStep {
  /** Значение `data-tour` у целевого элемента; null — шаг без цели, карточкой по центру. */
  target: string | null;
  title: string;
  text: string;
}

export const PRODUCT_TOUR_STEPS: readonly TourStep[] = [
  {
    target: "feed",
    title: "Ваша лента",
    text: "Закупки отобраны по профилю поиска; новые с прошлого визита помечены «Новая». Откройте закупку — внутри вердикт, риски и документы.",
  },
  {
    target: "search",
    title: "Поиск прямо сейчас",
    text: "Площадки сами опрашиваются каждые 2 часа. Нажмите, чтобы искать новые закупки немедленно.",
  },
  {
    target: "add-link",
    title: "Своя закупка по ссылке",
    text: "Есть закупка на примете? Вставьте ссылку из ЕИС — документы и анализ подтянутся сами.",
  },
  {
    target: null,
    title: "Глубокий анализ документации",
    text: "В карточке закупки нажмите «Глубокий анализ»: противоречия между документами, вопросы заказчику и сколько денег заморозится.",
  },
  {
    target: "nav-estimate",
    title: "Смета",
    text: "Смета по документации или проверка сметы заказчика по актуальным ценам ФГИС ЦС. Свою смету можно загрузить в Excel.",
  },
  {
    target: "nav-profile",
    title: "Профиль компании",
    text: "Заполните профиль и лицензии, когда будет время, — оценка «подходит ли закупка» станет точнее. Письма на почту — в разделе «Уведомления».",
  },
];

/** Отступ выреза вокруг элемента и зазор до карточки, px. */
const PAD = 6;
const GAP = 12;
const CARD_WIDTH = 340;
/** Примерная высота карточки: хватает ли места снизу или сверху от элемента. */
const CARD_HEIGHT = 210;
/** Уже этого — телефон: карточка внизу экрана, не рядом с элементом. */
const NARROW = 640;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Видимый прямоугольник цели или null: элемента нет, он скрыт или нулевого размера. */
function targetRect(target: string | null): Rect | null {
  if (target === null || typeof document === "undefined") return null;
  const element = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (element === null) return null;
  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  // Высокий элемент (лента) подсвечивается только видимой частью: вырез за краем экрана ничего не показывает.
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.top + box.height, window.innerHeight);
  if (bottom - top <= 0) return null;
  return { top, left: box.left, width: box.width, height: bottom - top };
}

function scrollTargetIntoView(target: string | null): void {
  if (target === null) return;
  const element = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (element === null) return;
  const box = element.getBoundingClientRect();
  if (box.top < 0 || box.bottom > window.innerHeight) {
    // Выше экрана — к началу, иначе к середине: у ленты важен верх, у кнопки — она сама.
    element.scrollIntoView?.({ block: box.height > window.innerHeight * 0.6 ? "start" : "center", behavior: "auto" });
  }
}

export function ProductTour({
  steps = PRODUCT_TOUR_STEPS,
  onClose,
}: {
  steps?: readonly TourStep[];
  /** Тур закончен («Готово») или закрыт («Пропустить», Esc). */
  onClose: (finished: boolean) => void;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ width: 1024, height: 768 });
  const cardRef = useRef<HTMLDivElement>(null);
  const step = steps[index] ?? steps[0]!;
  const last = index === steps.length - 1;

  const measure = useCallback(() => {
    setRect(targetRect(step.target));
    setViewport({ width: window.innerWidth, height: window.innerHeight });
  }, [step.target]);

  useLayoutEffect(() => {
    scrollTargetIntoView(step.target);
    measure();
  }, [measure, step.target]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  useEffect(() => {
    cardRef.current?.focus();
  }, [index]);

  const next = useCallback(() => {
    if (last) onClose(true);
    else setIndex((i) => Math.min(i + 1, steps.length - 1));
  }, [last, onClose, steps.length]);
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose(false);
      else if (event.key === "ArrowRight") next();
      else if (event.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, onClose]);

  const narrow = viewport.width < NARROW;
  // Карточка у элемента: снизу, если помещается, иначе сверху; по горизонтали — в пределах экрана.
  let cardStyle: React.CSSProperties;
  if (rect === null || narrow) {
    cardStyle = narrow
      ? { left: 12, right: 12, bottom: 12 }
      : { left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: CARD_WIDTH };
  } else {
    const below = rect.top + rect.height + PAD + GAP;
    const fitsBelow = below + CARD_HEIGHT < viewport.height;
    const fitsAbove = rect.top - PAD - GAP - CARD_HEIGHT > 0;
    const left = Math.min(Math.max(12, rect.left), viewport.width - CARD_WIDTH - 12);
    cardStyle = fitsBelow
      ? { top: below, left, width: CARD_WIDTH }
      : fitsAbove
        ? { bottom: viewport.height - rect.top + PAD + GAP, left, width: CARD_WIDTH }
        : // Элемент занимает почти весь экран — карточка поверх него, в правом нижнем углу.
          { right: 24, bottom: 88, width: CARD_WIDTH };
  }

  return (
    <div className="fixed inset-0 z-[100]" data-testid="product-tour">
      {rect !== null ? (
        <div
          aria-hidden
          className="pointer-events-none fixed rounded-control transition-all duration-200"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgba(15, 12, 10, 0.55)",
          }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0 bg-[rgba(15,12,10,0.55)]" />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-text"
        tabIndex={-1}
        className="fixed rounded-card border border-border bg-panel p-4 shadow-xl outline-none"
        style={cardStyle}
        data-testid="tour-card"
        data-target={step.target ?? "center"}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-[12.5px] font-medium text-faint">
            {index + 1} из {steps.length}
          </p>
          <button
            type="button"
            onClick={() => onClose(false)}
            className="-mr-1 -mt-1 rounded-control p-1 text-faint hover:bg-panel-raised hover:text-foreground"
            aria-label="Закрыть тур"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div aria-live="polite">
          <h2 id="tour-title" className="mt-1 text-[16px] font-semibold tracking-tight text-foreground">
            {step.title}
          </h2>
          <p id="tour-text" className="mt-1 text-[14px] leading-snug text-muted-foreground">
            {step.text}
          </p>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onClose(false)}
            className="text-[13.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Пропустить
          </button>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <Button size="sm" variant="secondary" onClick={prev}>
                Назад
              </Button>
            )}
            <Button size="sm" onClick={next}>
              {last ? "Готово" : "Далее"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
