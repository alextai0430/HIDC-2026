export function sanitizeAuditRows<T extends { action: string }>(rows: T[]) {
  return rows.map((row) =>
    row.action === "admin_tab_password_change"
      ? { ...row, prior: null, next: { password_changed: true } }
      : row,
  );
}
