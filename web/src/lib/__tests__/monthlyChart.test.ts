/**
 * The dashboard chart keeps an extreme margin month (1348%, -500%) inside
 * the plot: drawn at the edge of the margin axis with an out-of-scale
 * marker, and with the real value in the month's tooltip.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MonthlyChart } from "@/components/MonthlyChart";
import type { MonthlySeriesPoint } from "@/lib/reporting";

function point(period: string, netSales: number, directMargin: number): MonthlySeriesPoint {
  return {
    period,
    netSales,
    directCosts: netSales - directMargin,
    directMargin,
  } as MonthlySeriesPoint;
}

const series = [
  point("2026-07-01", 1000, 400), // 40%
  point("2026-08-01", 1000, 13480), // 1348% (negative direct costs)
  point("2026-09-01", 1000, -5000), // -500%
  point("2026-10-01", 0, 0), // no sales
];

function render() {
  return renderToStaticMarkup(createElement(MonthlyChart, { series, currency: "CLP" }));
}

describe("MonthlyChart margin line", () => {
  it("never draws the margin line outside the plot area", () => {
    const html = render();
    const polyline = html.match(/<polyline[^>]*points="([^"]+)"/)?.[1] ?? "";
    const ys = polyline.split(" ").map((pair) => Number(pair.split(",")[1]));
    expect(ys).toHaveLength(4);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(20);
      expect(y).toBeLessThanOrEqual(160);
    }
  });

  it("uses a capped axis and marks the two out-of-scale months", () => {
    const html = render();
    expect(html).toContain(">200%<");
    expect(html).toContain(">-100%<");
    expect(html.match(/data-out-of-scale="above"/g)).toHaveLength(1);
    expect(html.match(/data-out-of-scale="below"/g)).toHaveLength(1);
  });

  it("shows the real margin in the tooltip", () => {
    const html = render();
    expect(html).toContain("Margen: 1.348,0% (fuera de escala: el gráfico llega hasta 200%)");
    expect(html).toContain("Margen: -500,0% (fuera de escala: el gráfico llega hasta -100%)");
    expect(html).toContain("Margen: 40,0%");
    expect(html).toContain("Margen: sin ventas");
  });
});
