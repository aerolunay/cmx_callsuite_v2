/*
==================================================
downloadCsv — Phase 8 addition
==================================================
Builds a CSV client-side from data already in React state (no round
trip to the backend needed) and triggers a browser download. Used by:
- LiveStatusDashboard's "Download Calls CSV" / "Download Agent State
  CSV" buttons — exports exactly what's currently displayed/filtered
  in-app, per the explicit request.
- ReportsPage's "Download CSV" button — flattens the campaign->agent
  breakdown into one row-per-agent-per-campaign sheet.

columns: [{ label: "Column Header", value: "rowKey" | (row) => value }]
==================================================
*/
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function downloadCsv(filename, columns, rows) {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const lines = rows.map((row) =>
    columns
      .map((c) => csvEscape(typeof c.value === "function" ? c.value(row) : row[c.value]))
      .join(",")
  );
  const csv = [header, ...lines].join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
