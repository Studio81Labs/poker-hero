import { AlertTriangle, Check, Play, RefreshCcw, Upload } from "lucide-react";
import type { ChangeEvent, ReactNode } from "react";
import { useMemo, useState } from "react";

import "./App.css";
import { approveState, imageUrl, requestRecommendation, uploadScreenshot } from "./api";
import type { CanonicalState, Card, DetectedState, JobRecord, Rank, Street, Suit } from "./types";

const SUIT_BY_CODE: Record<string, Suit> = {
  c: "clubs",
  d: "diamonds",
  h: "hearts",
  s: "spades",
};

const CODE_BY_SUIT: Record<Suit, string> = {
  clubs: "c",
  diamonds: "d",
  hearts: "h",
  spades: "s",
};

const RANK_VALUES: readonly Rank[] = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const RANKS = new Set<string>(RANK_VALUES);

const EMPTY_STATE: CanonicalState = {
  hero_cards: [],
  board_cards: [],
  pot_size: null,
  current_bet: null,
  effective_stack: null,
  players_in_hand: null,
  hero_position: null,
  street: null,
  action_context: null,
  user_approved: false,
};

type StreetOption = "" | Street;

interface StateForm {
  hero_cards: string;
  board_cards: string;
  pot_size: string;
  current_bet: string;
  effective_stack: string;
  players_in_hand: string;
  hero_position: string;
  street: StreetOption;
  action_context: string;
}

function cardToCode(card: Card): string {
  return `${card.rank}${CODE_BY_SUIT[card.suit]}`;
}

function isRank(value: string): value is Rank {
  return RANKS.has(value);
}

function parseCards(value: string, label: string): Card[] {
  const cards = value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((code) => {
      const rawRank = code.slice(0, -1).toUpperCase();
      const rank = rawRank === "10" ? "T" : rawRank;
      const suit = SUIT_BY_CODE[code.slice(-1).toLowerCase()];
      if (!isRank(rank) || !suit) {
        throw new Error(`${label} contains an invalid card code: ${code}`);
      }
      return { rank, suit };
    });

  return cards;
}

function formatCards(cards: Card[]): string {
  return cards.map(cardToCode).join(" ");
}

function parseOptionalNumber(value: string, label: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function parseOptionalInteger(value: string, label: string): number | null {
  const parsed = parseOptionalNumber(value, label);
  if (parsed !== null && !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a whole number`);
  }
  if (parsed !== null && parsed < 1) {
    throw new Error(`${label} must be at least 1`);
  }
  return parsed;
}

function validateCardState(heroCards: Card[], boardCards: Card[]): void {
  if (heroCards.length > 2) {
    throw new Error("Hero cards cannot contain more than 2 cards");
  }
  if (boardCards.length > 5) {
    throw new Error("Board cards cannot contain more than 5 cards");
  }

  const seen = new Set<string>();
  for (const card of [...heroCards, ...boardCards]) {
    const code = cardToCode(card);
    if (seen.has(code)) {
      throw new Error(`Duplicate card in state: ${code}`);
    }
    seen.add(code);
  }
}

function confidenceLabel(value: number | undefined): string {
  if (value === undefined) {
    return "not detected";
  }
  return `${Math.round(value * 100)}%`;
}

function toCanonicalState(state: DetectedState | CanonicalState): CanonicalState {
  return {
    hero_cards: state.hero_cards,
    board_cards: state.board_cards,
    pot_size: state.pot_size,
    current_bet: state.current_bet,
    effective_stack: state.effective_stack,
    players_in_hand: state.players_in_hand,
    hero_position: state.hero_position,
    street: state.street,
    action_context: state.action_context,
    user_approved: "user_approved" in state ? state.user_approved : false,
  };
}

function stateFromJob(job: JobRecord): CanonicalState {
  if (job.approved_state) {
    return job.approved_state;
  }
  if (job.parser_result) {
    return toCanonicalState(job.parser_result.state);
  }
  return EMPTY_STATE;
}

function stateToForm(state: DetectedState | CanonicalState): StateForm {
  return {
    hero_cards: formatCards(state.hero_cards),
    board_cards: formatCards(state.board_cards),
    pot_size: state.pot_size === null ? "" : String(state.pot_size),
    current_bet: state.current_bet === null ? "" : String(state.current_bet),
    effective_stack: state.effective_stack === null ? "" : String(state.effective_stack),
    players_in_hand: state.players_in_hand === null ? "" : String(state.players_in_hand),
    hero_position: state.hero_position ?? "",
    street: state.street ?? "",
    action_context: state.action_context ?? "",
  };
}

function formToCanonical(form: StateForm): CanonicalState {
  const heroCards = parseCards(form.hero_cards, "Hero cards");
  const boardCards = parseCards(form.board_cards, "Board cards");
  validateCardState(heroCards, boardCards);

  return {
    hero_cards: heroCards,
    board_cards: boardCards,
    pot_size: parseOptionalNumber(form.pot_size, "Pot"),
    current_bet: parseOptionalNumber(form.current_bet, "Current bet"),
    effective_stack: parseOptionalNumber(form.effective_stack, "Effective stack"),
    players_in_hand: parseOptionalInteger(form.players_in_hand, "Players in hand"),
    hero_position: form.hero_position.trim() === "" ? null : form.hero_position.trim(),
    street: form.street === "" ? null : form.street,
    action_context: form.action_context.trim() === "" ? null : form.action_context.trim(),
    user_approved: false,
  };
}

function approvalKey(state: CanonicalState): string {
  return JSON.stringify({
    hero_cards: state.hero_cards.map(cardToCode),
    board_cards: state.board_cards.map(cardToCode),
    pot_size: state.pot_size,
    current_bet: state.current_bet,
    effective_stack: state.effective_stack,
    players_in_hand: state.players_in_hand,
    hero_position: state.hero_position,
    street: state.street,
    action_context: state.action_context,
  });
}

function clearApprovedResult(job: JobRecord): JobRecord {
  if (!job.approved_state && !job.recommendation) {
    return job;
  }

  return {
    ...job,
    status: job.parser_result ? "parsed" : "created",
    approved_state: null,
    recommendation: null,
  };
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [form, setForm] = useState<StateForm>(() => stateToForm(EMPTY_STATE));
  const [approvedStateKey, setApprovedStateKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = useMemo(() => {
    try {
      return { state: formToCanonical(form), error: null };
    } catch (validationError) {
      return { state: null, error: messageFromError(validationError, "Correct the detected state") };
    }
  }, [form]);
  const confidences: Record<string, number> = job?.parser_result?.confidences ?? {};
  const warnings = job?.parser_result?.warnings ?? [];
  const currentStateKey = validation.state ? approvalKey(validation.state) : null;
  const canApprove = Boolean(job?.parser_result && validation.state && validation.state.hero_cards.length > 0 && validation.state.street);
  const canRecommend = Boolean(job?.approved_state && currentStateKey && approvedStateKey === currentStateKey);
  const screenshotUrl = useMemo(() => (job ? imageUrl(job.id) : null), [job]);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files && event.target.files[0] ? event.target.files[0] : null);
  }

  async function onUpload() {
    if (!file) {
      return;
    }
    setBusy(true);
    setError(null);
    setJob(null);
    setForm(stateToForm(EMPTY_STATE));
    setApprovedStateKey(null);
    try {
      const created = await uploadScreenshot(file);
      const nextState = stateFromJob(created);
      setJob(created);
      setForm(stateToForm(nextState));
      setApprovedStateKey(created.approved_state ? approvalKey(created.approved_state) : null);
    } catch (uploadError) {
      setError(messageFromError(uploadError, "Upload failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    if (!job) {
      return;
    }
    if (!validation.state) {
      setError(validation.error ?? "Correct the detected state before approval");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const approved = await approveState(job.id, validation.state);
      const approvedState = approved.approved_state ?? { ...validation.state, user_approved: true };
      setJob(approved);
      setForm(stateToForm(approvedState));
      setApprovedStateKey(approvalKey(approvedState));
    } catch (approveError) {
      setError(messageFromError(approveError, "Approval failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onRecommend() {
    if (!job || !canRecommend) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const recommended = await requestRecommendation(job.id);
      setJob(recommended);
      if (recommended.approved_state) {
        setApprovedStateKey(approvalKey(recommended.approved_state));
      }
    } catch (recommendError) {
      setError(messageFromError(recommendError, "Recommendation failed"));
    } finally {
      setBusy(false);
    }
  }

  function updateForm(field: keyof StateForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setApprovedStateKey(null);
    setJob((current) => (current ? clearApprovedResult(current) : current));
  }

  function resetToParser() {
    if (job?.parser_result) {
      setForm(stateToForm(job.parser_result.state));
      setError(null);
      setApprovedStateKey(null);
      setJob((current) => (current ? clearApprovedResult(current) : current));
    }
  }

  return (
    <main className="app-shell">
      <section className="toolbar" aria-label="Analyzer controls">
        <div>
          <h1>Poker Training Analyzer</h1>
          <p>Post-hand review for Texas Hold&apos;em screenshots.</p>
        </div>
        <div className="toolbar-actions">
          <label className="file-picker">
            <Upload size={18} aria-hidden="true" />
            <span>{file ? file.name : "Choose screenshot"}</span>
            <input className="file-input" type="file" accept="image/*" aria-label="Choose screenshot" onChange={onFileChange} />
          </label>
          <button type="button" onClick={onUpload} disabled={!file || busy}>
            <Upload size={18} aria-hidden="true" />
            Upload and parse
          </button>
        </div>
      </section>

      {error ? (
        <div className="notice error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {job && validation.error ? (
        <div className="notice warning" role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{validation.error}</span>
        </div>
      ) : null}

      <section className="workspace">
        <div className="screenshot-pane">
          {screenshotUrl ? (
            <img src={screenshotUrl} alt="Uploaded poker table screenshot" />
          ) : (
            <div className="empty-screenshot">No screenshot uploaded</div>
          )}
        </div>

        <div className="review-pane">
          <div className="panel-header">
            <div>
              <h2>Detected State</h2>
              <span>{job ? `${job.parser_provider} parser` : "Waiting for upload"}</span>
            </div>
            {job ? <StatusPill status={job.status} /> : null}
          </div>

          {warnings.length > 0 ? (
            <div className="parser-warnings">
              <AlertTriangle size={16} aria-hidden="true" />
              <ul>
                {warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="field-grid">
            <Field label="Hero cards" confidence={confidenceLabel(confidences.hero_cards)}>
              <input value={form.hero_cards} onChange={(event) => updateForm("hero_cards", event.target.value)} />
            </Field>
            <Field label="Board cards" confidence={confidenceLabel(confidences.board_cards)}>
              <input value={form.board_cards} onChange={(event) => updateForm("board_cards", event.target.value)} />
            </Field>
            <Field label="Street" confidence={confidenceLabel(confidences.street)}>
              <select value={form.street} onChange={(event) => updateForm("street", event.target.value)}>
                <option value="">Select street</option>
                <option value="preflop">Preflop</option>
                <option value="flop">Flop</option>
                <option value="turn">Turn</option>
                <option value="river">River</option>
              </select>
            </Field>
            <Field label="Pot" confidence={confidenceLabel(confidences.pot_size)}>
              <input inputMode="decimal" value={form.pot_size} onChange={(event) => updateForm("pot_size", event.target.value)} />
            </Field>
            <Field label="Current bet" confidence={confidenceLabel(confidences.current_bet)}>
              <input inputMode="decimal" value={form.current_bet} onChange={(event) => updateForm("current_bet", event.target.value)} />
            </Field>
            <Field label="Effective stack" confidence={confidenceLabel(confidences.effective_stack)}>
              <input inputMode="decimal" value={form.effective_stack} onChange={(event) => updateForm("effective_stack", event.target.value)} />
            </Field>
            <Field label="Players in hand" confidence={confidenceLabel(confidences.players_in_hand)}>
              <input inputMode="numeric" value={form.players_in_hand} onChange={(event) => updateForm("players_in_hand", event.target.value)} />
            </Field>
            <Field label="Hero position" confidence={confidenceLabel(confidences.hero_position)}>
              <input value={form.hero_position} onChange={(event) => updateForm("hero_position", event.target.value)} />
            </Field>
            <Field label="Action context" confidence="manual review">
              <textarea value={form.action_context} onChange={(event) => updateForm("action_context", event.target.value)} />
            </Field>
          </div>

          <div className="review-actions">
            <button type="button" onClick={onApprove} disabled={!canApprove || busy}>
              <Check size={18} aria-hidden="true" />
              Approve state
            </button>
            <button type="button" onClick={onRecommend} disabled={!canRecommend || busy}>
              <Play size={18} aria-hidden="true" />
              Request recommendation
            </button>
            <button type="button" onClick={resetToParser} disabled={!job?.parser_result || busy}>
              <RefreshCcw size={18} aria-hidden="true" />
              Reset to parser
            </button>
          </div>

          {canRecommend && job?.recommendation ? (
            <section className="recommendation" aria-label="Recommendation">
              <div>
                <span className="recommendation-action">{job.recommendation.action}</span>
                <span className="recommendation-confidence">{Math.round(job.recommendation.confidence * 100)}% confidence</span>
              </div>
              {job.recommendation.sizing !== null ? <p>Suggested sizing: {job.recommendation.sizing}</p> : null}
              <p>{job.recommendation.explanation}</p>
            </section>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function Field({ label, confidence, children }: { label: string; confidence: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {label}
        <small>{confidence}</small>
      </span>
      {children}
    </label>
  );
}

function StatusPill({ status }: { status: JobRecord["status"] }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}
