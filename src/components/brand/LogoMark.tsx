import { cn } from "@/lib/cn";

/**
 * Знак ТендерФит: буква «Т», ножка которой переходит в галочку.
 *
 * Буква — название, галочка — то, ради чего сервисом пользуются: ответ «можно
 * участвовать». Линии толстые намеренно: знак живёт и во вкладке браузера в
 * 16 пикселях, где тонкая галочка превращалась в штрих.
 *
 * Координаты общие для всех мест, где знак рисуется (интерфейс, иконка вкладки,
 * иконка для телефона, картинка превью ссылки), — меняются здесь и только здесь.
 */
export const LOGO_MARK = {
  /** Плашка в координатах 0…100: квадрат 88 со скруглением 22. */
  tile: { x: 6, y: 6, size: 88, radius: 22 },
  /** Перекладина «Т», ножка и галочка одной линией. */
  path: "M26 29 H72 M49 29 V60 L60 71 L79 45",
  strokeWidth: 13,
  /** Фирменный оранжевый — тот же, что токен --accent. */
  color: "#F2541B",
} as const;

/** Квадратная плашка знака без полей: рамка рисунка совпадает с плашкой. */
const VIEW_BOX = `${LOGO_MARK.tile.x} ${LOGO_MARK.tile.y} ${LOGO_MARK.tile.size} ${LOGO_MARK.tile.size}`;

export function LogoMark({
  size = 32,
  className,
  title,
}: {
  size?: number;
  className?: string;
  /** Подпись для чтения с экрана; без неё знак декоративный (рядом стоит название). */
  title?: string;
}) {
  return (
    <svg
      viewBox={VIEW_BOX}
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role={title === undefined ? undefined : "img"}
      aria-hidden={title === undefined ? true : undefined}
    >
      {title !== undefined && <title>{title}</title>}
      <rect
        x={LOGO_MARK.tile.x}
        y={LOGO_MARK.tile.y}
        width={LOGO_MARK.tile.size}
        height={LOGO_MARK.tile.size}
        rx={LOGO_MARK.tile.radius}
        className="fill-accent"
      />
      <path
        d={LOGO_MARK.path}
        fill="none"
        stroke="#fff"
        strokeWidth={LOGO_MARK.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
