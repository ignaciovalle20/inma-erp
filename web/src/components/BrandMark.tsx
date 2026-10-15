// Isotipo "iN" de Inmasoft. Mismo dibujo que app/icon.svg.
export function BrandMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="349 80 740 740"
      width={size}
      height={size}
      role="img"
      aria-label="Inmasoft"
      className={className}
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
  );
}
