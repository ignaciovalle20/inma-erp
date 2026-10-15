import { ImageResponse } from "next/og";

// Respaldo PNG para navegadores que no soportan favicon SVG.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="349 80 740 740"
          width={32}
          height={32}
        >
          <g
            fill="none"
            stroke="#36B4E5"
            strokeWidth="96"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M426 348V597a97 97 0 0 0 194 0V205l392 489V533M1012 205v196" />
          </g>
          <circle cx="426" cy="208" r="48.5" fill="#36B4E5" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
