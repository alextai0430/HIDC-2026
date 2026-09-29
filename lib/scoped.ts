import {
  categories,
  executionLabels,
  type Competitor,
  type Profile,
  type Submission,
} from "./model";
import { canManage } from "./access";

export function ownSubmissions(profile: Profile, submissions: Submission[]) {
  return submissions.filter((s) => s.user_id === profile.id);
}

export function isPerformanceSubmission(submission: Submission) {
  return submission.scoring_type === "performance";
}

// This helper only controls whether an authenticated judge's own performance
// values are retained in the private offline cache. Display/API access still
// requires Admin unlock plus the in-memory Show Points switch.
export function canViewOwnPerformancePoints(profile: Profile, submission: Submission) {
  return ["performance_judge", "organizer", "server_admin", "judge"].includes(profile.role) &&
    submission.user_id === profile.id && isPerformanceSubmission(submission);
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
    Judge: s.user_id === profile.id ? profile.name : profiles.find((candidate) => candidate.id === s.user_id)?.name ?? s.judge_name_snapshot ?? "Deleted Judge",
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
