'use client';

import { cn } from '@/utils/Helpers';

export type Column<T> = {
  header: string;
  key: keyof T & string;
  align?: 'left' | 'center' | 'right';
  render?: (value: T[keyof T], row: T) => React.ReactNode;
};

export function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  emptyMessage = 'Sin datos',
}: {
  columns: Column<T>[];
  rows: T[];
  emptyMessage?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-background shadow-xs">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase">
          <tr>
            {columns.map(c => (
              <th
                key={c.key}
                className={cn(
                  'px-3 py-2',
                  c.align === 'right' && 'text-right',
                  c.align === 'center' && 'text-center',
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0
            ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    {emptyMessage}
                  </td>
                </tr>
              )
            : rows.map((row, i) => (
                <tr key={i} className="border-t">
                  {columns.map(c => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-3 py-2',
                        c.align === 'right' && 'text-right',
                        c.align === 'center' && 'text-center',
                      )}
                    >
                      {c.render
                        ? c.render(row[c.key], row)
                        : String(row[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
