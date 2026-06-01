// Streaming fallback for every dashboard view. Next renders this instantly on
// navigation while the route's Server Component fetches its data, so a click
// shows structure immediately instead of a frozen screen. One boundary here
// covers all child segments (products, sales, cash, reports, ...).

function Bar({ className = '' }: { className?: string }) {
  return (
    <div className={`
      animate-pulse rounded-md bg-muted
      ${className}
    `}
    />
  );
}

export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      {/* TitleBar placeholder */}
      <div className="mb-8">
        <Bar className="h-8 w-56" />
        <Bar className="mt-2 h-4 w-80 max-w-full" />
      </div>

      {/* Metric/summary cards */}
      <div className="
        grid grid-cols-1 gap-4
        sm:grid-cols-2
        lg:grid-cols-4
      "
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className="rounded-xl border border-border bg-card p-5"
          >
            <Bar className="h-4 w-24" />
            <Bar className="mt-3 h-7 w-32" />
            <Bar className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>

      {/* Main content block (chart / table area) */}
      <div className="mt-6 rounded-xl border border-border bg-card p-5">
        <Bar className="h-5 w-40" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Bar
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              className="h-10 w-full"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
