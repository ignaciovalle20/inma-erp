import type { MonthlySeriesPoint } from "@/lib/reporting";
import { formatAmount, formatDecimal } from "@/components/Money";
import { marginAxis, marginPosition } from "@/lib/marginAxis";

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

// Same formula as before: direct margin over net sales, 0 without sales.
function marginPct(point: MonthlySeriesPoint): number {
  return point.netSales !== 0 ? (point.directMargin / point.netSales) * 100 : 0;
}

function formatPct(value: number): string {
  return `${formatDecimal(value, 1)}%`;
}

/**
 * Sales/costs bars share the left scale; the margin % line has its own
 * scale (labels on the right), computed from the data but capped to
 * -100%..200% (lib/marginAxis). A month beyond it is drawn at the edge
 * with a triangle, and its tooltip gives the real value.
 */
export function MonthlyChart({
  series,
  currency,
}: {
  series: MonthlySeriesPoint[];
  currency: string;
}) {
  const width = 780;
  const axisLabelWidth = 40;
  const plotWidth = width - axisLabelWidth;
  const baseY = 160;
  const topY = 20;
  const chartHeight = baseY - topY;
  const maxAmount =
    Math.max(1, ...series.map((p) => Math.max(p.netSales, p.directCosts))) *
    1.1;

  const margins = series.map(marginPct);
  const axis = marginAxis(margins);
  const marginY = (value: number) =>
    baseY - ((value - axis.min) / (axis.max - axis.min)) * chartHeight;

  const groupWidth = plotWidth / Math.max(1, series.length);
  const barWidth = 14;

  const points = series.map((point, i) => {
    const cx = groupWidth * i + groupWidth / 2;
    const position = marginPosition(margins[i], axis);
    return { point, cx, margin: margins[i], ...position, y: marginY(position.shown) };
  });

  const axisTicks = Array.from(new Set([axis.max, axis.min, ...(axis.min < 0 ? [0] : [])]));
  const anyOutOfScale = points.some((p) => p.outOfScale);

  return (
    <svg
      viewBox={`0 0 ${width} 200`}
      className="w-full"
      role="img"
      aria-label={`Ventas, costos y margen de los últimos ${series.length} meses${
        anyOutOfScale ? "; hay meses con el margen fuera de la escala del gráfico" : ""
      }`}
    >
      <line x1={0} y1={baseY} x2={plotWidth} y2={baseY} stroke="var(--color-hairline)" />
      {[110, 60, 20].map((y) => (
        <line key={y} x1={0} y1={y} x2={plotWidth} y2={y} stroke="var(--color-hairline-soft)" />
      ))}
      {axis.min < 0 ? (
        <line
          x1={0}
          y1={marginY(0)}
          x2={plotWidth}
          y2={marginY(0)}
          stroke="var(--color-hairline)"
          strokeDasharray="3 3"
        />
      ) : null}
      {axisTicks.map((tick) => (
        <text
          key={tick}
          x={width - 2}
          y={marginY(tick) + 3}
          textAnchor="end"
          fontFamily="var(--font-mono)"
          fontSize={9.5}
          fill="var(--color-muted)"
        >
          {tick}%
        </text>
      ))}

      {points.map(({ point, cx }) => {
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
        strokeLinejoin="round"
        points={points.map(({ cx, y }) => `${cx},${y}`).join(" ")}
      />
      {points.map(({ point, cx, y, outOfScale }) =>
        outOfScale ? (
          <g key={point.period}>
            <circle cx={cx} cy={y} r={3} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.4} />
            <path
              d={
                outOfScale === "above"
                  ? `M ${cx - 4} ${y - 5} L ${cx + 4} ${y - 5} L ${cx} ${y - 11} Z`
                  : `M ${cx - 4} ${y + 5} L ${cx + 4} ${y + 5} L ${cx} ${y + 11} Z`
              }
              fill="var(--color-warning)"
            />
          </g>
        ) : (
          <circle key={point.period} cx={cx} cy={y} r={2.4} fill="var(--color-ink)" />
        ),
      )}

      {/* One transparent column per month, on top, so hovering anywhere in
          it shows the month's real numbers (native SVG tooltip). */}
      {points.map(({ point, cx, margin, outOfScale }) => {
        const month = new Date(point.period);
        const marginText =
          point.netSales === 0
            ? "sin ventas"
            : `${formatPct(margin)}${
                outOfScale === "above"
                  ? ` (fuera de escala: el gráfico llega hasta ${axis.max}%)`
                  : outOfScale === "below"
                    ? ` (fuera de escala: el gráfico llega hasta ${axis.min}%)`
                    : ""
              }`;
        return (
          <rect
            key={point.period}
            x={cx - groupWidth / 2}
            y={0}
            width={groupWidth}
            height={185}
            fill="transparent"
            data-out-of-scale={outOfScale ?? undefined}
          >
            <title>
              {`${MONTH_LABELS[month.getUTCMonth()]} ${month.getUTCFullYear()}\nVentas: ${formatAmount(point.netSales, currency)} ${currency}\nCostos: ${formatAmount(point.directCosts, currency)} ${currency}\nMargen: ${marginText}`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}
