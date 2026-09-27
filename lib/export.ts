export function download(
  rows: Record<string, unknown>[],
  format: "csv" | "txt",
  name: string,
) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const safe = (v: unknown) => {
    const s = v == null ? "Pending" : String(v);
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  };
  const sep = format === "csv" ? "," : "\t";
  const cell = (v: unknown) =>
    format === "csv"
      ? `"${safe(v).replaceAll('"', '""')}"`
      : safe(v).replaceAll("\t", " ").replaceAll("\n", " ");
  const content = [
    keys.map(cell).join(sep),
    ...rows.map((r) => keys.map((k) => cell(r[k])).join(sep)),
  ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob(["\ufeff" + content], {
      type:
        format === "csv"
          ? "text/csv;charset=utf-8"
          : "text/plain;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `hidc-${name}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}
