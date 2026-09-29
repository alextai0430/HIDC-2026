import { Competitor, Event, Ranking, Submission } from "./model";
import type { ScoringRules } from "./model";

export function eventScore(e: Event, rules: ScoringRules) {
  if (Object.hasOwn(rules.deductions, e.trick)) return rules.deductions[e.trick];
  const [type, dimension] = e.trick.split(" ");
  const base = rules.bases[type]?.[dimension];
  const level = rules.levels[String(e.level)];
  if (base === undefined || level === undefined) return 0;
  const execution = rules.executions?.[e.execution ?? "E0"] ?? 1;
  return base * level * e.features.reduce((value, feature) => value * (rules.features[feature] ?? 1), 1) * execution;
}
export function total(s: Submission, rules: ScoringRules) {
  return s.dq
    ? 0
    : (s.scoring_type ?? (s.slot <= 3 ? "technical" : "performance")) === "technical"
      ? s.events.reduce((v, e) => v + eventScore(e, rules), 0)
      : s.performance.reduce((a, b) => a + b, 0);
}
export function rankGlobal(
  competitors: Competitor[],
  submissions: Submission[],
  rules: ScoringRules,
  assignments?: { division: string; slot: number; user_id: string; scoring_type?: "technical" | "performance" }[],
): Ranking[] {
  const rows = competitors
    .filter((c) => !c.archived && c.division !== "Exhibition")
    .map((c) => {
      const divisionAssignments = assignments
        ? assignments.filter((assignment) => assignment.division === c.division).sort((a, b) => a.slot - b.slot)
        : [...new Map(submissions
            .filter((submission) => competitors.find((candidate) => candidate.id === submission.competitor_id)?.division === c.division)
            .map((submission) => [submission.user_id, {
              division: c.division,
              slot: submission.slot,
              user_id: submission.user_id,
              scoring_type: submission.scoring_type ?? (submission.slot <= 3 ? "technical" : "performance"),
            }])).values()];
      const slots = divisionAssignments.map((assignment) => submissions.find(
        (s) => s.competitor_id === c.id && s.user_id === assignment.user_id &&
          (s.scoring_type ?? (s.slot <= 3 ? "technical" : "performance")) ===
            (assignment.scoring_type ?? (assignment.slot <= 3 ? "technical" : "performance")) && s.finished,
      ));
      const values = slots.map((s) => (s ? total(s, rules) : null));
      const technicalIndexes = divisionAssignments.flatMap((assignment, index) =>
        (assignment.scoring_type ?? (assignment.slot <= 3 ? "technical" : "performance")) === "technical" ? [index] : [],
      );
      const performanceIndexes = divisionAssignments.flatMap((assignment, index) =>
        (assignment.scoring_type ?? (assignment.slot <= 3 ? "technical" : "performance")) === "performance" ? [index] : [],
      );
      const technicalValues = technicalIndexes.map((index) => values[index]);
      const performanceValues = performanceIndexes.map((index) => values[index]);
      const complete = divisionAssignments.length >= 2 && technicalIndexes.length > 0 && performanceIndexes.length > 0 && slots.every(Boolean);
      const mean = (scores: (number | null)[]) => scores.length && scores.every((score) => score !== null)
        ? scores.reduce<number>((sum, score) => sum + (score ?? 0), 0) / scores.length
        : null;
      return {
        competitor: c,
        technical: technicalValues,
        performance: performanceValues,
        raw: mean(technicalValues),
        scaled: null,
        average: mean(performanceValues),
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
