import { Competitor, Event, Ranking, Submission } from "./model";
const bases: Record<string, Record<string, number>> = {
  "#": { "2D": 0.7, "3D": 6, "4D": 15 },
  T: { "1D": 0.1, "2D": 1, "3D": 6, "4D": 12, VD: 0.2 },
  O: { "1D": 0.2, "2D": 1.2, "3D": 4, "4D": 8, VD: 0.5 },
  F: { "2D": 1.5, "3D": 5, "4D": 10 },
  S: { "1D": 0.1, "2D": 1, "3D": 6, "4D": 12, VD: 0.2 },
  W: { "1D": 0.2, VD: 0.4 },
  R: { "1D": 0.4, "2D": 1.2, "3D": 6, "4D": 12, VD: 1 },
};
const penalties: Record<string, number> = {
  "Unintentional Drop": -0.3,
  Tangle: -0.5,
  "Time Violation": -2,
  "Other Rule Violation": -2,
};
const features: Record<string, number> = { T1: 1.7, T2: 3, T3: 5, A: 1.7 };
export function eventScore(e: Event) {
  if (e.trick in penalties) return penalties[e.trick];
  const [type, dimension] = e.trick.split(" ");
  return (
    (bases[type]?.[dimension] ?? 0) *
    e.level *
    e.features.reduce((v, f) => v * features[f], 1)
  );
}
export function total(s: Submission) {
  return s.dq
    ? 0
    : s.slot <= 3
      ? s.events.reduce((v, e) => v + eventScore(e), 0)
      : s.performance.reduce((a, b) => a + b, 0);
}
export function rankGlobal(
  competitors: Competitor[],
  submissions: Submission[],
): Ranking[] {
  const rows = competitors
    .filter((c) => !c.archived && c.division !== "Exhibition")
    .map((c) => {
      const slots = [1, 2, 3, 4, 5].map((slot) =>
        submissions.find(
          (s) => s.competitor_id === c.id && s.slot === slot && s.finished,
        ),
      );
      const values = slots.map((s) => (s ? total(s) : null));
      const complete = slots.every(Boolean);
      return {
        competitor: c,
        technical: values.slice(0, 3),
        performance: values.slice(3),
        raw: values.slice(0, 3).every((v) => v !== null)
          ? values.slice(0, 3).reduce<number>((a, b) => a + (b ?? 0), 0)
          : null,
        scaled: null,
        average:
          values[3] !== null && values[4] !== null
            ? (values[3] + values[4]) / 2
            : null,
        final: null,
        complete,
        dq: c.dq || submissions.some((s) => s.competitor_id === c.id && s.dq),
        rank: null,
      } as Ranking;
    });
  for (const division of new Set(rows.map((r) => r.competitor.division))) {
    const group = rows.filter((r) => r.competitor.division === division);
    const max = Math.max(
      0,
      ...group.filter((r) => r.complete && !r.dq).map((r) => r.raw ?? 0),
    );
    for (const r of group) {
      if (r.dq) {
        r.final = 0;
        r.scaled = 0;
      } else if (r.complete) {
        r.scaled = max > 0 ? (Math.max(0, r.raw!) / max) * 70 : 0;
        r.final = r.scaled + (r.average ?? 0);
      }
    }
    const sorted = group
      .filter((r) => r.final !== null)
      .sort(
        (a, b) =>
          Number(a.dq) - Number(b.dq) ||
          b.final! - a.final! ||
          a.competitor.position - b.competitor.position,
      );
    sorted.forEach(
      (r, i) =>
        (r.rank =
          i > 0 && r.dq === sorted[i - 1].dq && r.final === sorted[i - 1].final
            ? sorted[i - 1].rank
            : i + 1),
    );
  }
  return rows.sort(
    (a, b) =>
      a.competitor.division.localeCompare(b.competitor.division) ||
      (a.rank ?? 999) - (b.rank ?? 999),
  );
}
