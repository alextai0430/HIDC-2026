export function serializeCsvRows(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    const numeric = typeof value === "number" && Number.isFinite(value);
    let text = value == null ? "Pending" : String(value);
    if (!numeric && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [keys.map(cell).join(","), ...rows.map((row) => keys.map((key) => cell(row[key])).join(","))].join("\r\n");
}

export function download(
  rowsOrContent: Record<string, unknown>[] | string,
  format: "csv" | "txt",
  name: string,
) {
  let content: string;
  if (typeof rowsOrContent === "string") {
    content = rowsOrContent;
  } else {
    if (!rowsOrContent.length) return;
    if (format === "csv") {
      content = serializeCsvRows(rowsOrContent);
    } else {
      const keys = Object.keys(rowsOrContent[0]);
      const safe = (value: unknown) => {
        const text = value == null ? "Pending" : String(value);
        return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      };
      content = [
        keys.join("\t"),
        ...rowsOrContent.map((row) => keys.map((key) => safe(row[key]).replaceAll("\t", " ").replaceAll("\n", " ")).join("\t")),
      ].join("\r\n");
    }
  }
  if (!content) return;
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
