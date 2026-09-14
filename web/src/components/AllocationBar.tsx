export type AllocationSegment = { label: string; share: number; color: string };

const PALETTE = [
  "var(--color-accent-strong)",
  "var(--color-accent)",
  "var(--color-accent-bright)",
];

/** Segment color by index -- palette cycles from the 4th segment on, dimmed. */
export function allocationColor(index: number): { color: string; opacity: number } {
  return {
    color: PALETTE[index % PALETTE.length],
    opacity: index < PALETTE.length ? 1 : 0.75,
  };
}

export function AllocationBar({
  segments,
  className = "",
}: {
  segments: AllocationSegment[];
  className?: string;
}) {
  const assigned = segments.reduce((sum, segment) => sum + segment.share, 0);
  const remainder = Math.max(0, 1 - assigned);

  return (
    <div
      className={`flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-row)] ${className}`}
    >
      {segments.map((segment, index) => (
        <div
          key={index}
          title={segment.label}
          style={{ width: `${segment.share * 100}%`, backgroundColor: segment.color }}
        />
      ))}
      {remainder > 0.001 ? (
        <div
          style={{
            width: `${remainder * 100}%`,
            backgroundImage:
              "repeating-linear-gradient(135deg, var(--color-warning-soft-border) 0 4px, var(--color-warning-soft) 4px 8px)",
          }}
        />
      ) : null}
    </div>
  );
}
