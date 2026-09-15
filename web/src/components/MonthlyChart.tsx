import type { MonthlySeriesPoint } from "@/lib/reporting";

const MONTH_LABELS = [
  "ENE",
  "FEB",
  "MAR",
  "ABR",
  "MAY",
  "JUN",
  "JUL",
  "AGO",
  "SEP",
  "OCT",
  "NOV",
  "DIC",
];

export function MonthlyChart({ series }: { series: MonthlySeriesPoint[] }) {
  const width = 780;
  const baseY = 160;
  const topY = 20;
  const chartHeight = baseY - topY;
  const maxAmount =
    Math.max(1, ...series.map((p) => Math.max(p.netSales, p.directCosts))) *
    1.1;
  const maxMarginPct = 30;

  const groupWidth = width / series.length;
  const barWidth = 14;

  return (
    <svg viewBox={`0 0 ${width} 200`} className="w-full">
      <line
        x1={0}
        y1={baseY}
        x2={width}
        y2={baseY}
        stroke="var(--color-hairline)"
      />
      {[110, 60, 20].map((y) => (
        <line
          key={y}
          x1={0}
          y1={y}
          x2={width}
          y2={y}
          stroke="var(--color-hairline-soft)"
        />
      ))}
      {series.map((point, i) => {
        const cx = groupWidth * i + groupWidth / 2;
        const salesH = (point.netSales / maxAmount) * chartHeight;
        const costsH = (point.directCosts / maxAmount) * chartHeight;
        return (
          <g key={point.period}>
            <rect
              x={cx - barWidth - 2}
              y={baseY - salesH}
              width={barWidth}
              height={salesH}
              rx={2}
              fill="var(--color-accent)"
            />
            <rect
              x={cx + 2}
              y={baseY - costsH}
              width={barWidth}
              height={costsH}
              rx={2}
              fill="var(--color-neutral-bar)"
            />
            <text
              x={cx}
              y={178}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={9.5}
              fill="var(--color-muted)"
            >
              {MONTH_LABELS[new Date(point.period).getUTCMonth()]}
            </text>
          </g>
        );
      })}
      <polyline
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth={1.6}
        points={series
          .map((point, i) => {
            const cx = groupWidth * i + groupWidth / 2;
            const marginPct =
              point.netSales !== 0
                ? (point.directMargin / point.netSales) * 100
                : 0;
            const y =
              baseY - (Math.max(0, marginPct) / maxMarginPct) * chartHeight;
            return `${cx},${y}`;
          })
          .join(" ")}
      />
      {series.map((point, i) => {
        const cx = groupWidth * i + groupWidth / 2;
        const marginPct =
          point.netSales !== 0
            ? (point.directMargin / point.netSales) * 100
            : 0;
        const y = baseY - (Math.max(0, marginPct) / maxMarginPct) * chartHeight;
        return (
          <circle key={point.period} cx={cx} cy={y} r={2.4} fill="var(--color-ink)" />
        );
      })}
    </svg>
  );
}
