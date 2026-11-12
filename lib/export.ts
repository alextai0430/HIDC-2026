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
    const keys = Object.keys(rowsOrContent[0]);
    const safe = (v: unknown) => {
      const s = v == null ? "Pending" : String(v);
      return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    };
    const sep = format === "csv" ? "," : "\t";
    const cell = (v: unknown) =>
      format === "csv"
        ? `"${safe(v).replaceAll('"', '""')}"`
        : safe(v).replaceAll("\t", " ").replaceAll("\n", " ");
    content = [
      keys.map(cell).join(sep),
      ...rowsOrContent.map((r) => keys.map((k) => cell(r[k])).join(sep)),
    ].join("\r\n");
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
