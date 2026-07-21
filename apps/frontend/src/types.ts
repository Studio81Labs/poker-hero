export type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A";
export type Suit = "clubs" | "diamonds" | "hearts" | "spades";
export type Street = "preflop" | "flop" | "turn" | "river";
export type FacingAction = "bet" | "raise";
export type RecommendationAction = "fold" | "check" | "call" | "bet" | "raise";

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
  recorded_at: string;
}

export type TrainingOutcome = "match" | "same_action" | "different";

export interface TrainingStreetSummary {
  street: Street;
  reviewed_hands: number;
  action_matches: number;
  exact_matches: number;
  action_accuracy: number;
  exact_accuracy: number;
}

export interface TrainingRecentHand {
  job_id: string;
  original_filename: string;
  street: Street | null;
  hero_cards: Card[];
  decision_action: RecommendationAction;
  decision_sizing: number | null;
  recommended_action: RecommendationAction;
  recommended_sizing: number | null;
  outcome: TrainingOutcome;
  recorded_at: string;
  reviewed_at: string | null;
}

export interface TrainingProgress {
  reviewed_hands: number;
  action_matches: number;
  exact_matches: number;
  different_actions: number;
  needs_review_hands: number;
  action_accuracy: number;
  exact_accuracy: number;
  street_summaries: TrainingStreetSummary[];
  recent_hands: TrainingRecentHand[];
  review_queue: TrainingRecentHand[];
}

export interface JobRecord {
  id: string;
  status: "created" | "parsed" | "approved" | "recommended" | "error";
  original_filename: string;
  image_filename: string;
  parser_provider: string;
  recommendation_provider: string;
  parser_result: ParserResult | null;
  approved_state: CanonicalState | null;
  training_decision: TrainingDecision | null;
  recommendation: RecommendationResult | null;
  training_reviewed_at: string | null;
  benchmark_included: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
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
