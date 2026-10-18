"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/cn";

/**
 * Шестизначный код по одной цифре в ячейке.
 *
 * Поведение, которого ждут от такого поля:
 *  - вставка шести цифр (из письма, из буфера) заполняет все ячейки;
 *  - ввод цифры двигает фокус вправо, Backspace в пустой ячейке — влево и
 *    стирает предыдущую; стрелки ходят по ячейкам;
 *  - автозаполнение из СМС и подсказка клавиатуры телефона (`one-time-code`)
 *    кладут код целиком в одну ячейку — значит, любое многозначное значение
 *    разбирается как вставка;
 *  - нецифры отбрасываются.
 *
 * Значение живёт у родителя строкой до шести знаков: форма проверяет и отправляет
 * его так же, как обычное поле (`/^\d{6}$/`). Стёртая ячейка посередине остаётся
 * пробелом, чтобы цифры правее не съезжали, — такое значение проверку не проходит. Ячейки без maxLength намеренно: iOS и Android
 * не вставляют код автозаполнения в поле, которое принимает один знак.
 */

export const CODE_LENGTH = 6;

interface CodeInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Поле подсвечено как ошибочное: неверный или просроченный код. */
  invalid?: boolean;
  disabled?: boolean;
  /** Подпись группы для скринридера. */
  label?: string;
  /** Поставить фокус в первую пустую ячейку при появлении. */
  autoFocus?: boolean;
}

const digitsOf = (raw: string): string => raw.replace(/\D/g, "");

export function CodeInput({
  value,
  onChange,
  invalid = false,
  disabled = false,
  label = "Код из письма",
  autoFocus = false,
}: CodeInputProps) {
  const cells = useRef<Array<HTMLInputElement | null>>([]);
  /** Цифра в ячейке или пустая строка: пробел в значении — стёртая ячейка посередине. */
  const cellAt = (index: number): string => {
    const char = value[index];
    return char !== undefined && char !== " " ? char : "";
  };

  useEffect(() => {
    if (autoFocus) cells.current[0]?.focus();
  }, [autoFocus]);

  const focusCell = (index: number): void => {
    const target = cells.current[Math.min(Math.max(index, 0), CODE_LENGTH - 1)];
    target?.focus();
    target?.select();
  };

  const emit = (chars: string[]): void => onChange(chars.join("").slice(0, CODE_LENGTH).trimEnd());

  /** Кладёт цифры, начиная с ячейки `from`, и ведёт фокус за последней. */
  const fill = (from: number, digits: string): void => {
    const chars = value.padEnd(CODE_LENGTH, " ").split("");
    let at = from;
    for (const digit of digits) {
      if (at >= CODE_LENGTH) break;
      chars[at] = digit;
      at += 1;
    }
    emit(chars);
    focusCell(at);
  };

  const clearAt = (index: number): void => {
    const chars = value.padEnd(CODE_LENGTH, " ").split("");
    chars[index] = " ";
    emit(chars);
  };

  const handleChange = (index: number, raw: string): void => {
    const digits = digitsOf(raw);
    if (digits === "") {
      if (cellAt(index) !== "") clearAt(index);
      return;
    }
    // Набрали цифру поверх уже стоящей без выделения: «15» из «1» и нажатой «5» — это замена, а не вставка.
    const old = cellAt(index);
    if (digits.length === 2 && old !== "") {
      fill(index, digits[0] === old ? (digits[1] ?? old) : (digits[0] ?? old));
      return;
    }
    // Одна цифра — обычный ввод; несколько — вставка или автозаполнение из СМС (целый код — с начала).
    fill(digits.length >= CODE_LENGTH ? 0 : index, digits.slice(0, CODE_LENGTH));
  };

  const handlePaste = (index: number, event: React.ClipboardEvent<HTMLInputElement>): void => {
    event.preventDefault();
    const digits = digitsOf(event.clipboardData.getData("text"));
    if (digits === "") return;
    // Целый код — с начала, независимо от того, куда поставлен курсор.
    fill(digits.length >= CODE_LENGTH ? 0 : index, digits.slice(0, CODE_LENGTH));
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case "Backspace":
        if (cellAt(index) === "" && index > 0) {
          event.preventDefault();
          clearAt(index - 1);
          focusCell(index - 1);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusCell(index - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        focusCell(index + 1);
        break;
      default:
    }
  };

  return (
    <div role="group" aria-label={label} className="grid grid-cols-6 gap-2 sm:gap-2.5">
      {Array.from({ length: CODE_LENGTH }, (_, index) => (
        <input
          key={index}
          ref={(node) => {
            cells.current[index] = node;
          }}
          value={cellAt(index)}
          onChange={(event) => handleChange(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onPaste={(event) => handlePaste(index, event)}
          onFocus={(event) => event.target.select()}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          aria-label={`Цифра ${String(index + 1)} из ${String(CODE_LENGTH)}`}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          className={cn(
            "num h-12 min-w-0 rounded-control border bg-panel text-center text-[22px] font-semibold text-foreground sm:h-14 sm:text-[24px]",
            "transition-colors focus:outline-none focus:ring-2 focus:ring-accent/25 focus:border-accent",
            "disabled:cursor-not-allowed disabled:opacity-60",
            invalid ? "border-brick bg-brick-subtle" : cellAt(index) !== "" ? "border-border-strong" : "border-border",
          )}
        />
      ))}
    </div>
  );
}
