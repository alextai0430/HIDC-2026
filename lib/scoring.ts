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
  if (s.dq) return 0;
  if (s.scoring_type === "technical") return s.events.reduce((v, e) => v + eventScore(e, rules), 0);
  if (s.scoring_type === "performance") return s.performance.reduce((a, b) => a + b, 0);
  return 0;
}
export function rankGlobal(
  competitors: Competitor[],
  submissions: Submission[],
  rules: ScoringRules,
  assignments?: { division: string; slot: number; user_id: string; scoring_type?: "technical" | "performance" }[],
  judgeRoster?: { competitor_id: string; user_id: string; scoring_type: "technical" | "performance"; roster_order: number; display_name: string; role_snapshot?: string; expected: boolean }[],
): Ranking[] {
  const rows = competitors
    .filter((c) => !c.archived && c.division !== "Exhibition")
    .map((c) => {
      const officialRoster = judgeRoster?.filter((judge) => judge.competitor_id === c.id && judge.expected)
        .sort((a, b) => a.roster_order - b.roster_order);
      const divisionAssignments: { division: string; slot: number; user_id: string; scoring_type?: "technical" | "performance"; expected?: boolean }[] = officialRoster
        ? officialRoster.map((judge) => ({
            division: c.division, slot: judge.roster_order, user_id: judge.user_id, scoring_type: judge.scoring_type, expected: judge.expected,
          }))
        : assignments
        ? assignments.filter((assignment) => assignment.division === c.division).sort((a, b) => a.slot - b.slot)
        : [...new Map(submissions
            .filter((submission) => competitors.find((candidate) => candidate.id === submission.competitor_id)?.division === c.division)
            .filter((submission) => submission.historical_user_id || submission.user_id)
            .map((submission) => [submission.historical_user_id ?? submission.user_id!, {
              division: c.division,
              slot: submission.slot,
              user_id: submission.historical_user_id ?? submission.user_id!,
              scoring_type: submission.scoring_type,
            }])).values()];
      const typedAssignments = divisionAssignments.filter(
        (assignment) => assignment.scoring_type === "technical" || assignment.scoring_type === "performance",
      );
      const slots = typedAssignments.map((assignment) => assignment.expected === false ? undefined : submissions.find(
        (s) => s.competitor_id === c.id && (s.user_id === assignment.user_id || s.historical_user_id === assignment.user_id) &&
          s.scoring_type === assignment.scoring_type && s.finished,
      ));
      const values = slots.map((s) => (s ? total(s, rules) : null));
      const technicalIndexes = typedAssignments.flatMap((assignment, index) =>
        assignment.scoring_type === "technical" ? [index] : [],
      );
      const performanceIndexes = typedAssignments.flatMap((assignment, index) =>
        assignment.scoring_type === "performance" ? [index] : [],
      );
      const technicalValues = technicalIndexes.map((index) => values[index]);
      const performanceValues = performanceIndexes.map((index) => values[index]);
      const eligibleIndexes = typedAssignments.flatMap((assignment, index) => assignment.expected === false ? [] : [index]);
      const complete = eligibleIndexes.length >= 2 && eligibleIndexes.length <= 10 &&
        technicalIndexes.some((index) => typedAssignments[index].expected !== false) &&
        performanceIndexes.some((index) => typedAssignments[index].expected !== false) &&
        eligibleIndexes.every((index) => Boolean(slots[index]));
      const mean = (scores: (number | null)[]) => scores.length && scores.every((score) => score !== null)
        ? scores.reduce<number>((sum, score) => sum + (score ?? 0), 0) / scores.length
        : null;
      return {
        competitor: c,
        judges: typedAssignments.map((assignment) => {
          const snapshot = officialRoster?.find((judge) => judge.user_id === assignment.user_id);
          const historical = submissions.find((submission) => submission.competitor_id === c.id &&
            (submission.user_id === assignment.user_id || submission.historical_user_id === assignment.user_id));
          return {
            user_id: assignment.user_id,
            scoring_type: assignment.scoring_type,
            roster_order: assignment.slot,
            display_name: snapshot?.display_name ?? historical?.judge_name_snapshot ?? "Former judge",
          };
        }),
        technical: technicalValues,
        performance: performanceValues,
        raw: mean(technicalIndexes.flatMap((index) => typedAssignments[index].expected === false ? [] : [values[index]])),
        scaled: null,
        average: mean(performanceIndexes.flatMap((index) => typedAssignments[index].expected === false ? [] : [values[index]])),
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
