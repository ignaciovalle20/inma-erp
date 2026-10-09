export function TableCard({ children }: { children: React.ReactNode }) {
  return (
    // The table scrolls sideways inside its card, never the whole page.
    <div className="surface-card max-w-full overflow-x-auto">
      <table className="w-full text-body">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  className = "",
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      className={`caps-label whitespace-nowrap px-3 py-2.5 text-[var(--color-muted)] ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className = "",
  ...rest
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
} & React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      {...rest}
      className={`border-t border-[var(--color-row)] px-3 py-2.5 align-top ${
        align === "right" ? "text-right tabular-nums" : "text-left"
      } ${className}`}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <tr className={`hover:bg-[var(--color-surface-muted)] ${className}`}>
      {children}
    </tr>
  );
}
