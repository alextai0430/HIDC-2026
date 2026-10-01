import {
  categories,
  executionLabels,
  type Competitor,
  type Profile,
  type ScoringRules,
  type Submission,
} from "./model";
import { canManage } from "./access";
import { eventScore, total } from "./scoring";

export function ownSubmissions(profile: Profile, submissions: Submission[]) {
  return submissions.filter((s) => s.user_id === profile.id);
}

export function isPerformanceSubmission(submission: Submission) {
  return submission.scoring_type === "performance";
}

// Performance judges may see only their own live Performance score. Score
// Details and exports keep their separate Admin/Show Points masking rules.
export function canViewOwnPerformancePoints(profile: Profile, submission: Submission) {
  return profile.role === "performance_judge" &&
    submission.user_id === profile.id && isPerformanceSubmission(submission);
}

/**
 * Shape a submission for the authenticated state response. A Performance Judge
 * may see only their own six category values and total; all other score values
 * still require the Admin unlock and Show Points session flag.
 */
export function stateSubmissionForProfile(
  profile: Profile,
  submission: Submission,
  revealPoints: boolean,
  rules: ScoringRules,
): Submission {
  if (revealPoints) {
    return {
      ...submission,
      total: total(submission, rules),
      events: submission.events.map((event) => ({
        ...event,
        value: eventScore(event, rules),
      })),
    };
  }

  const ownPerformance = canViewOwnPerformancePoints(profile, submission);
  return {
    ...submission,
    performance: ownPerformance ? submission.performance : [],
    events: submission.events.map(({ value: _value, ...event }) => event),
    total: ownPerformance ? total(submission, rules) : undefined,
  };
}

export function detailSubmissions(profile: Profile, submissions: Submission[]) {
  return canManage(profile)
    ? submissions
    : ownSubmissions(profile, submissions);
}

export function detailExportRows(
  profile: Profile,
  submissions: Submission[],
  competitors: Competitor[],
  revealPoints = false,
  profiles: Profile[] = [],
) {
  return detailSubmissions(profile, submissions).map((s) => ({
    Competitor: competitors.find((c) => c.id === s.competitor_id)?.name,
    Judge: `Judge ${s.slot}`,
    Scoring: s.scoring_type ?? "Unknown",
    Status: s.finished ? "Submitted" : "Draft",
    DQ: s.dq,
    Updated: s.updated_at,
    Events: JSON.stringify(
      s.events.map((e) => ({
        ...(revealPoints && e.value !== undefined ? e : {
          id: e.id,
          trick: e.trick,
          level: e.level,
          features: e.features,
          at: e.at,
        }),
        execution: executionLabels[e.execution ?? "E0"],
      })),
    ),
    ...(revealPoints
      ? { Total: s.total, Performance: s.performance.join(" / ") }
      : {}),
  }));
}

export function personalScoreExportRows(
  profile: Profile,
  submissions: Submission[],
  competitors: Competitor[],
  revealPoints = false,
) {
  return ownSubmissions(profile, submissions).map((s) => {
    const type = s.scoring_type;
    return {
      Competitor: competitors.find((c) => c.id === s.competitor_id)?.name,
      Status: s.finished ? "Submitted" : "Draft",
      Total: revealPoints ? s.total ?? "—" : "***",
      ...(type === "technical"
        ? {
            Events: JSON.stringify(
              s.events.map((e) => ({
                trick: e.trick,
                level: e.level,
                features: e.features,
                execution: executionLabels[e.execution ?? "E0"],
                at: e.at,
                points: revealPoints ? e.value ?? "—" : "***",
              })),
            ),
          }
        : type === "performance"
          ? Object.fromEntries(categories.map((c, i) => [c, revealPoints ? s.performance[i] : "***"]))
          : {}),
    };
  });
}
