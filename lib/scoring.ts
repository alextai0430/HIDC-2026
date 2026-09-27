import { Competitor, Event, Ranking, Submission } from "./model";
import type { ScoringRules } from "./model";

export function eventScore(e: Event, rules: ScoringRules) {
  if (Object.hasOwn(rules.deductions, e.trick)) return rules.deductions[e.trick];
  const [type, dimension] = e.trick.split(" ");
  const base = rules.bases[type]?.[dimension];
  const level = rules.levels[String(e.level)];
  if (base === undefined || level === undefined) return 0;
  return base * level * e.features.reduce((value, feature) => value * (rules.features[feature] ?? 1), 1);
}
export function total(s: Submission, rules: ScoringRules) {
  return s.dq
    ? 0
    : s.slot <= 3
      ? s.events.reduce((v, e) => v + eventScore(e, rules), 0)
      : s.performance.reduce((a, b) => a + b, 0);
}
export function rankGlobal(
  competitors: Competitor[],
  submissions: Submission[],
  rules: ScoringRules,
): Ranking[] {
  const rows = competitors
    .filter((c) => !c.archived && c.division !== "Exhibition")
    .map((c) => {
      const slots = [1, 2, 3, 4, 5].map((slot) =>
        submissions.find(
          (s) => s.competitor_id === c.id && s.slot === slot && s.finished,
        ),
      );
      const values = slots.map((s) => (s ? total(s, rules) : null));
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
