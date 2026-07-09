export type Suit = "clubs" | "diamonds" | "hearts" | "spades";
export type Street = "preflop" | "flop" | "turn" | "river";
export type RecommendationAction = "fold" | "check" | "call" | "bet" | "raise";

export interface Card {
  rank: string;
  suit: Suit;
}

export interface DetectedState {
  hero_cards: Card[];
  board_cards: Card[];
  pot_size: number | null;
  current_bet: number | null;
  effective_stack: number | null;
  players_in_hand: number | null;
  hero_position: string | null;
  street: Street | null;
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

export interface JobRecord {
  id: string;
  status: "created" | "parsed" | "approved" | "recommended" | "error";
  original_filename: string;
  image_filename: string;
  parser_provider: string;
  recommendation_provider: string;
  parser_result: ParserResult | null;
  approved_state: CanonicalState | null;
  recommendation: RecommendationResult | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
