import { ImageResponse } from "next/og";

// iOS no respeta transparencia: fondo blanco opaco y margen alrededor del isotipo.
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
          background: "#FFFFFF",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="229 -40 980 980"
          width={180}
          height={180}
        >
          <rect x="229" y="-40" width="980" height="980" fill="#FFFFFF" />
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
