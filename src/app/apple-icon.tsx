import { ImageResponse } from "next/og";

import { LOGO_MARK } from "@/components/brand/LogoMark";

/**
 * Иконка сайта на экране «Домой» телефона.
 *
 * Квадрат без скругления: iOS и Android скругляют углы сами, а своё скругление
 * под их маской давало бы белые уголки. Поэтому оранжевый — во весь квадрат, а
 * знак — по центру, с полями, чтобы маска не срезала галочку.
 */

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: LOGO_MARK.color,
        }}
      >
        <svg width="150" height="150" viewBox="6 6 88 88">
          <path
            d={LOGO_MARK.path}
            fill="none"
            stroke="#fff"
            strokeWidth={LOGO_MARK.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    size,
  );
}
