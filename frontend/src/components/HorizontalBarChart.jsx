/*
==================================================
HorizontalBarChart — NEW, for the Leads Calling Dashboard
==================================================
A plain, dependency-free horizontal bar chart: each bar's width is a
percentage of the largest value in the set (or of an explicit max,
when the values are already percentages capped at 100 — e.g. Contact
Rate/Connect Rate charts pass max=100 so a 40% bar and a 90% bar from
two different charts stay visually comparable to each other, not just
within their own chart).

bars: [{ label, value, displayValue? }]
  - value        : number used to size the bar's width.
  - displayValue : optional pre-formatted string shown next to the
                    bar (e.g. "42.3%" or "128 (37.1%)"). Falls back to
                    the raw value if omitted.

Deliberately NOT built with SVG/canvas — this is a static horizontal
bar list, and divs/CSS render it with far less code and no viewBox/
scaling math to get wrong. If a future chart on this dashboard needs
something SVG can do and CSS can't (e.g. a real donut chart), that's a
genuinely different component, not a reason to rewrite this one.
==================================================
*/
export default function HorizontalBarChart({ bars, max, color = "var(--cmx-cyan)", emptyMessage = "No data in this range." }) {
  if (!bars || bars.length === 0) {
    return <p style={{ color: "#888", margin: 0 }}>{emptyMessage}</p>;
  }

  const effectiveMax = max ?? Math.max(...bars.map((b) => b.value || 0), 1);

  return (
    <div className="hbar-chart">
      {bars.map((bar) => {
        const widthPct = effectiveMax > 0 ? Math.min(100, ((bar.value || 0) / effectiveMax) * 100) : 0;
        return (
          <div className="hbar-row" key={bar.label}>
            <div className="hbar-label" title={bar.label}>
              {bar.label}
            </div>
            <div className="hbar-track">
              <div className="hbar-fill" style={{ width: `${widthPct}%`, background: color }} />
            </div>
            <div className="hbar-value">{bar.displayValue ?? bar.value}</div>
          </div>
        );
      })}
    </div>
  );
}
