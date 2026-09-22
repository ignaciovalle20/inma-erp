export function TableCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)]">
      <table className="w-full text-[13px]">{children}</table>
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
      className={`whitespace-nowrap px-3 py-2 font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-[var(--color-muted)] ${
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
        align === "right" ? "text-right" : "text-left"
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
