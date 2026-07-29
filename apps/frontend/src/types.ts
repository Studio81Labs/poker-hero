export type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A";
export type Suit = "clubs" | "diamonds" | "hearts" | "spades";
export type Street = "preflop" | "flop" | "turn" | "river";
export type FacingAction = "bet" | "raise";
export type RecommendationAction = "fold" | "check" | "call" | "bet" | "raise";
export type TrainingCertainty = "low" | "medium" | "high";

export interface Card {
  rank: Rank;
  suit: Suit;
}

export interface DetectedState {
  hero_cards: Card[];
  board_cards: Card[];
  pot_size: number | null;
  current_bet: number | null;
  hero_stack: number | null;
  effective_stack: number | null;
  players_in_hand: number | null;
  hero_position: string | null;
  preflop_opener_position: string | null;
  preflop_open_size: number | null;
  street: Street | null;
  facing_action: FacingAction | null;
  action_context: string | null;
}

export interface ParserResult {
  state: DetectedState;
  confidences: Record<string, number>;
  warnings: string[];
  raw: Record<string, unknown>;
}

export interface CanonicalState extends DetectedState {
  user_approved: boolean;
}

export interface RecommendationResult {
  action: RecommendationAction;
  sizing: number | null;
  confidence: number;
  explanation: string;
  raw: Record<string, unknown>;
}

export interface TrainingDecision {
  action: RecommendationAction;
  sizing: number | null;
  certainty?: TrainingCertainty | null;
  recorded_at: string;
}

export type TrainingOutcome = "match" | "mixed" | "same_action" | "mixed_action" | "different";
export type TrainingReviewOrder = "recent" | "ev_loss";
export type TrainingReviewStreet = "all" | Street;
export type TrainingReviewCertainty = TrainingCertainty | "unrated";
export type TrainingReviewCertaintyFilter = "all" | TrainingReviewCertainty;

export interface TrainingStreetSummary {
  street: Street;
  reviewed_hands: number;
  action_matches: number;
  exact_matches: number;
  action_accuracy: number;
  exact_accuracy: number;
  ev_compared_hands: number;
  average_ev_loss_bb: number | null;
  trend?: TrainingTrend | null;
}

export interface TrainingPositionSummary {
  position: string;
  reviewed_hands: number;
  action_matches: number;
  exact_matches: number;
  needs_review_hands?: number;
  action_accuracy: number;
  exact_accuracy: number;
  ev_compared_hands: number;
  average_ev_loss_bb: number | null;
  trend?: TrainingTrend | null;
}

export interface TrainingCertaintySummary {
  certainty: TrainingCertainty;
  hands: number;
  action_matches: number;
  exact_matches: number;
  needs_review_hands?: number;
  action_accuracy: number;
  exact_accuracy: number;
  ev_compared_hands: number;
  average_ev_loss_bb: number | null;
  trend?: TrainingTrend | null;
}

export interface TrainingRecentHand {
  job_id: string;
  original_filename: string;
  street: Street | null;
  hero_cards: Card[];
  decision_action: RecommendationAction;
  decision_sizing: number | null;
  decision_certainty?: TrainingCertainty | null;
  recommended_action: RecommendationAction;
  recommended_sizing: number | null;
  outcome: TrainingOutcome;
  recorded_at: string;
  reviewed_at: string | null;
  review_note: string | null;
  ev_loss_bb: number | null;
}

export interface TrainingTrend {
  window_hands: number;
  recent_action_accuracy: number;
  previous_action_accuracy: number;
  action_accuracy_delta: number;
  recent_exact_accuracy: number;
  previous_exact_accuracy: number;
  exact_accuracy_delta: number;
  recent_ev_compared_hands: number;
  previous_ev_compared_hands: number;
  recent_average_ev_loss_bb: number | null;
  previous_average_ev_loss_bb: number | null;
  average_ev_loss_delta_bb: number | null;
}

export interface TrainingActionDifference {
  decision_action: RecommendationAction;
  recommended_action: RecommendationAction;
  hands: number;
  needs_review_hands: number;
  ev_compared_hands: number;
  average_ev_loss_bb: number | null;
}

export interface TrainingSolverRouteSummary {
  key: string;
  engine: string;
  hands: number;
  fallback_hands: number;
  action_matches?: number;
  exact_matches?: number;
  action_accuracy?: number;
  exact_accuracy?: number;
  ev_compared_hands?: number;
  average_ev_loss_bb?: number | null;
  trend?: TrainingTrend | null;
  street_counts: Partial<Record<Street, number>>;
}

export interface TrainingSolverFallbackSummary {
  key: string;
  reason: string;
  hands: number;
  action_matches?: number;
  exact_matches?: number;
  action_accuracy?: number;
  exact_accuracy?: number;
  ev_compared_hands?: number;
  average_ev_loss_bb?: number | null;
  trend?: TrainingTrend | null;
  street_counts: Partial<Record<Street, number>>;
}

export type TrainingSolverFilter =
  | {
    kind: "route" | "fallback";
    key: string;
    label: string;
  }
  | {
    kind: "unattributed";
    label: string;
  };

export type TrainingPositionFilter =
  | {
    kind: "position";
    position: string;
    label: string;
  }
  | {
    kind: "unpositioned";
    label: string;
  };

export interface TrainingStreetFilter {
  street: Street;
  label: string;
}

export interface TrainingCertaintyFilter {
  certainty: TrainingReviewCertainty;
  label: string;
}

export interface TrainingSolverCoverageTrend {
  window_hands: number;
  recent_attribution_rate: number;
  previous_attribution_rate: number;
  attribution_rate_delta: number;
  recent_fallback_rate: number;
  previous_fallback_rate: number;
  fallback_rate_delta: number;
}

export interface TrainingSolverCoverage {
  total_hands: number;
  tracked_hands: number;
  unattributed_hands: number;
  fallback_hands: number;
  fallback_rate: number;
  trend?: TrainingSolverCoverageTrend | null;
  routes: TrainingSolverRouteSummary[];
  fallback_reasons: TrainingSolverFallbackSummary[];
}

export type TrainingReviewDifference = Pick<
  TrainingActionDifference,
  "decision_action" | "recommended_action"
>;

export interface TrainingProgress {
  reviewed_hands: number;
  action_matches: number;
  exact_matches: number;
  different_actions: number;
  needs_review_hands: number;
  action_accuracy: number;
  exact_accuracy: number;
  ev_compared_hands: number;
  average_ev_loss_bb: number | null;
  trend?: TrainingTrend | null;
  action_differences?: TrainingActionDifference[];
  solver_coverage?: TrainingSolverCoverage;
  certainty_summaries?: TrainingCertaintySummary[];
  unrated_hands?: number;
  unrated_needs_review_hands?: number;
  street_summaries: TrainingStreetSummary[];
  position_summaries?: TrainingPositionSummary[];
  unpositioned_hands?: number;
  unpositioned_needs_review_hands?: number;
  recent_matching_hands?: number;
  recent_hands: TrainingRecentHand[];
  lesson_count?: number;
  lesson_matching_hands?: number;
  lesson_hands?: TrainingRecentHand[];
  review_street_counts?: Partial<Record<Street, number>>;
  review_queue_hands: number;
  review_queue: TrainingRecentHand[];
}

export interface JobRecord {
  id: string;
  status: "created" | "parsed" | "approved" | "recommended" | "error";
  upload_request_id?: string | null;
  original_filename: string;
  image_filename: string;
  parser_provider: string;
  recommendation_provider: string;
  parser_result: ParserResult | null;
  approved_state: CanonicalState | null;
  training_decision: TrainingDecision | null;
  recommendation: RecommendationResult | null;
  recommendation_pending: boolean;
  recommendation_request_id?: string | null;
  training_reviewed_at: string | null;
  training_review_note: string | null;
  benchmark_included: boolean;
  archived_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobHistory {
  total: number;
  jobs: JobRecord[];
  snapshot_version?: string;
}

export interface JobQueue {
  total: number;
  jobs: JobRecord[];
  snapshot_version?: string;
}

export interface SystemInfo {
  status: string;
  parser_provider: string;
  recommendation_provider: string;
  recommendation_engine?: string;
}

export interface BenchmarkFieldComparison {
  field: string;
  expected: unknown;
  detected: unknown;
  matched: boolean;
  confidence: number | null;
}

export interface BenchmarkCaseResult {
  job_id: string;
  original_filename: string;
  status: "completed" | "error";
  correct_fields: number;
  evaluated_fields: number;
  accuracy: number;
  warnings: string[];
  error: string | null;
  comparisons: BenchmarkFieldComparison[];
}

export interface BenchmarkFieldMetric {
  field: string;
  correct: number;
  total: number;
  accuracy: number;
}

export interface BenchmarkReport {
  id: string;
  parser_provider: string;
  layout_profile: string;
  created_at: string;
  total_cases: number;
  successful_cases: number;
  failed_cases: number;
  correct_fields: number;
  evaluated_fields: number;
  accuracy: number;
  field_metrics: BenchmarkFieldMetric[];
  cases: BenchmarkCaseResult[];
}

export interface BenchmarkReportSummary {
  id: string;
  parser_provider: string;
  layout_profile: string;
  created_at: string;
  total_cases: number;
  failed_cases: number;
  accuracy: number;
  field_metrics?: BenchmarkFieldMetric[];
}

export interface BenchmarkOverview {
  included_cases: number;
  latest_report: BenchmarkReport | null;
  recent_reports: BenchmarkReportSummary[];
}

export interface BenchmarkDatasetImportResult {
  imported_cases: number;
  reused_cases: number;
  included_cases: number;
  job_ids: string[];
}
