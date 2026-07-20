import { AlertTriangle, Archive, Camera, Check, FlaskConical, Info, Play, RefreshCcw, Settings, Square, Upload, X } from "lucide-react";
import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import "./App.css";
import {
  approveState,
  getBenchmarkOverview,
  getSystemInfo,
  imageUrl,
  requestRecommendation,
  runParserBenchmark,
  setBenchmarkInclusion,
  uploadScreenshot,
} from "./api";
import type {
  BenchmarkOverview,
  CanonicalState,
  Card,
  DetectedState,
  FacingAction,
  JobRecord,
  Rank,
  Street,
  Suit,
  SystemInfo,
} from "./types";

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
  hero_stack: null,
  effective_stack: null,
  players_in_hand: null,
  hero_position: null,
  street: null,
  facing_action: null,
  action_context: null,
  user_approved: false,
};

type StreetOption = "" | Street;
type FacingActionOption = "" | FacingAction;
type ShareMode = "browser" | "window" | "monitor";
type InputMode = "live" | "upload";

type ExtendedDisplayMediaOptions = DisplayMediaStreamOptions & {
  monitorTypeSurfaces?: "include" | "exclude";
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
};

type DisplayMediaTrackSettings = MediaTrackSettings & {
  displaySurface?: unknown;
};

interface StateForm {
  hero_cards: string;
  board_cards: string;
  pot_size: string;
  current_bet: string;
  hero_stack: string;
  effective_stack: string;
  players_in_hand: string;
  hero_position: string;
  street: StreetOption;
  facing_action: FacingActionOption;
  action_context: string;
}

interface HistoryItem {
  id: string;
  job: JobRecord;
  savedAt: string;
}

interface QueueProgress {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  currentIndex: number;
  currentFile: string;
  aborting: boolean;
}

const HISTORY_STORAGE_KEY = "poker-training-history-v1";
const ERROR_TOAST_ID = "poker-training-error";
const VALIDATION_TOAST_ID = "poker-training-validation";

const PROVIDER_LABELS: Record<string, string> = {
  custom_local: "Custom local solver",
  external_solver: "External solver",
  llm_advice: "LLM adviser",
  llm_vision: "External vision model",
  local_ev: "Local EV solver",
  local_solver: "Local solver",
  mock: "Demo engine",
  ocr_cv: "OCR + computer vision",
  postflop_solver: "Postflop solver",
  rule_based: "Rule-based trainer",
};

const SHARE_MODES: readonly { value: ShareMode; label: string }[] = [
  { value: "browser", label: "Tab" },
  { value: "window", label: "Window" },
  { value: "monitor", label: "Screen" },
];

const CONFIDENCE_KEYS = [
  "hero_cards",
  "board_cards",
  "street",
  "pot_size",
  "current_bet",
  "hero_stack",
  "effective_stack",
  "players_in_hand",
  "hero_position",
  "facing_action",
  "action_context",
] as const;

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.replace(/_/g, " ");
}

function benchmarkFieldLabel(field: string): string {
  return field.replace(/_/g, " ");
}

function benchmarkPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function readHistory(): HistoryItem[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

function writeHistory(items: HistoryItem[]): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items.slice(0, 24)));
}

function cardToCode(card: Card): string {
  return `${card.rank}${CODE_BY_SUIT[card.suit]}`;
}

function cardToDisplay(card: Card): string {
  const suit = card.suit === "spades" ? "♠" : card.suit === "hearts" ? "♥" : card.suit === "diamonds" ? "♦" : "♣";
  return `${card.rank}${suit}`;
}

function isRedSuit(card: Card): boolean {
  return card.suit === "hearts" || card.suit === "diamonds";
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

function confidencePercent(value: number | undefined): number {
  return value === undefined ? 0 : Math.round(value * 100);
}

function confidenceTone(value: number | undefined): string {
  if (value === undefined) {
    return "missing";
  }
  if (value < 0.7) {
    return "low";
  }
  if (value < 0.85) {
    return "medium";
  }
  return "high";
}

function summarizeConfidences(confidences: Record<string, number>, warnings: string[]) {
  const values = CONFIDENCE_KEYS.map((key) => confidences[key]).filter((value): value is number => value !== undefined);
  const detectedCount = values.length;
  const averageConfidence = detectedCount === 0 ? 0 : Math.round((values.reduce((sum, value) => sum + value, 0) / detectedCount) * 100);
  const reviewCount = values.filter((value) => value < 0.7).length + warnings.length;

  return {
    averageConfidence,
    detectedCount,
    fieldTotal: CONFIDENCE_KEYS.length,
    reviewCount,
  };
}

function toCanonicalState(state: DetectedState | CanonicalState): CanonicalState {
  return {
    hero_cards: state.hero_cards,
    board_cards: state.board_cards,
    pot_size: state.pot_size,
    current_bet: state.current_bet,
    hero_stack: state.hero_stack ?? null,
    effective_stack: state.effective_stack,
    players_in_hand: state.players_in_hand,
    hero_position: state.hero_position,
    street: state.street,
    facing_action: state.facing_action ?? null,
    action_context: state.action_context,
    user_approved: "user_approved" in state ? state.user_approved : false,
  };
}

function stateFromJob(job: JobRecord): CanonicalState {
  if (job.approved_state) {
    return toCanonicalState(job.approved_state);
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
    hero_stack: state.hero_stack == null ? "" : String(state.hero_stack),
    effective_stack: state.effective_stack === null ? "" : String(state.effective_stack),
    players_in_hand: state.players_in_hand === null ? "" : String(state.players_in_hand),
    hero_position: state.hero_position ?? "",
    street: state.street ?? "",
    facing_action: state.facing_action ?? "",
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
    hero_stack: parseOptionalNumber(form.hero_stack, "Hero stack"),
    effective_stack: parseOptionalNumber(form.effective_stack, "Effective stack"),
    players_in_hand: parseOptionalInteger(form.players_in_hand, "Players in hand"),
    hero_position: form.hero_position.trim() === "" ? null : form.hero_position.trim(),
    street: form.street === "" ? null : form.street,
    facing_action: form.facing_action === "" ? null : form.facing_action,
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
    hero_stack: state.hero_stack ?? null,
    effective_stack: state.effective_stack,
    players_in_hand: state.players_in_hand,
    hero_position: state.hero_position,
    street: state.street,
    facing_action: state.facing_action ?? null,
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

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function selectedFilesLabel(files: File[]): string {
  if (files.length === 0) {
    return "Choose screenshots";
  }
  if (files.length === 1) {
    return files[0].name;
  }
  return `${files.length} screenshots selected`;
}

function relativeTimeLabel(isoDate: string): string {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(isoDate).getTime()) / 1000));
  if (elapsedSeconds < 60) {
    return "just now";
  }
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min ago`;
  }
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} hr ago`;
  }
  const elapsedDays = Math.round(elapsedHours / 24);
  return `${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
}

function captureName(): string {
  return `screen-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
}

function shareModeLabel(mode: ShareMode): string {
  return SHARE_MODES.find((option) => option.value === mode)?.label ?? "Window";
}

function displaySurfaceLabel(displaySurface: unknown): string | null {
  if (displaySurface === "browser") {
    return "Tab";
  }
  if (displaySurface === "window") {
    return "Window";
  }
  if (displaySurface === "monitor") {
    return "Screen";
  }
  return null;
}

function displayMediaOptions(mode: ShareMode): ExtendedDisplayMediaOptions {
  const options: ExtendedDisplayMediaOptions = {
    audio: false,
    monitorTypeSurfaces: mode === "monitor" ? "include" : "exclude",
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: mode === "browser" ? "include" : "exclude",
    video: {
      frameRate: 8,
      displaySurface: mode,
    } as MediaTrackConstraints,
  };

  return options;
}

function displaySurfaceMatchesMode(displaySurface: unknown, mode: ShareMode): boolean {
  if (displaySurface !== "browser" && displaySurface !== "window" && displaySurface !== "monitor") {
    return true;
  }
  return displaySurface === mode;
}

function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

function wrongShareModeMessage(displaySurface: unknown, mode: ShareMode): string {
  const selectedLabel = displaySurfaceLabel(displaySurface) ?? "Different source";
  const expectedLabel = shareModeLabel(mode).toLowerCase();
  return `${selectedLabel} was selected. Choose a ${expectedLabel} in the browser share picker, or switch the source type before sharing.`;
}

function getDisplaySurface(stream: MediaStream): unknown {
  return (stream.getVideoTracks()[0]?.getSettings() as DisplayMediaTrackSettings | undefined)?.displaySurface;
}

function autoApprovalState(job: JobRecord, allowWarnings: boolean): CanonicalState {
  if (!job.parser_result) {
    throw new Error("Automation stopped: parser did not return a state");
  }
  if (!allowWarnings && job.parser_result.warnings.length > 0) {
    throw new Error("Automation stopped: parser warnings need manual review");
  }

  const state = formToCanonical(stateToForm(toCanonicalState(job.parser_result.state)));
  if (state.hero_cards.length === 0 || !state.street) {
    throw new Error("Automation stopped: parser state needs manual review");
  }
  return state;
}

function historyCards(job: JobRecord): Card[] {
  const state = job.approved_state ?? job.parser_result?.state ?? EMPTY_STATE;
  return state.hero_cards.slice(0, 2);
}

function historyAction(job: JobRecord): string {
  if (job.recommendation) {
    return job.recommendation.action;
  }
  return job.approved_state ? "approved" : job.status;
}

function isHistoryReady(job: JobRecord): boolean {
  return job.status === "approved" || job.status === "recommended" || job.approved_state !== null || job.recommendation !== null;
}

function createLocalErrorJob(file: File, message: string, index: number): JobRecord {
  const timestamp = new Date().toISOString();
  return {
    id: `local-error-${Date.now()}-${index}`,
    status: "error",
    original_filename: file.name,
    image_filename: "",
    parser_provider: "client",
    recommendation_provider: "none",
    parser_result: null,
    approved_state: null,
    recommendation: null,
    benchmark_included: false,
    error: message,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function markJobNeedsAttention(job: JobRecord, message: string): JobRecord {
  return {
    ...job,
    status: "error",
    error: message,
    updated_at: new Date().toISOString(),
  };
}

function queueDetail(job: JobRecord): string {
  if (job.status === "error") {
    return job.error ?? "Needs attention";
  }
  if (job.parser_result && job.parser_result.warnings.length > 0) {
    return "Review warnings";
  }
  return job.parser_result?.state.street ?? "No street";
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [form, setForm] = useState<StateForm>(() => stateToForm(EMPTY_STATE));
  const [approvedStateKey, setApprovedStateKey] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>("live");
  const [shareMode, setShareMode] = useState<ShareMode>("window");
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenSourceLabel, setScreenSourceLabel] = useState<string | null>(null);
  const [livePreviewVisible, setLivePreviewVisible] = useState(false);
  const [automationEnabled, setAutomationEnabled] = useState(true);
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const [benchmarkDialogOpen, setBenchmarkDialogOpen] = useState(false);
  const [benchmarkOverview, setBenchmarkOverview] = useState<BenchmarkOverview | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkUpdating, setBenchmarkUpdating] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const [automationApprove, setAutomationApprove] = useState(true);
  const [automationRecommend, setAutomationRecommend] = useState(true);
  const [automationAllowWarnings, setAutomationAllowWarnings] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => readHistory());
  const [queueProgress, setQueueProgress] = useState<QueueProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setErrorMessage] = useState<string | null>(null);
  const [errorSequence, setErrorSequence] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const queueAbortControllerRef = useRef<AbortController | null>(null);
  const queueAbortRequestedRef = useRef(false);

  const job = useMemo(() => jobs.find((candidate) => candidate.id === activeJobId) ?? jobs[0] ?? null, [activeJobId, jobs]);
  const validation = useMemo(() => {
    try {
      return { state: formToCanonical(form), error: null };
    } catch (validationError) {
      return { state: null, error: messageFromError(validationError, "Correct the detected state") };
    }
  }, [form]);
  const confidences: Record<string, number> = job?.parser_result?.confidences ?? {};
  const parserWarnings = job?.parser_result?.warnings ?? [];
  const warnings = job?.error ? [...parserWarnings, job.error] : parserWarnings;
  const currentStateKey = validation.state ? approvalKey(validation.state) : null;
  const currentStateApproved = Boolean(job?.approved_state && currentStateKey && approvedStateKey === currentStateKey);
  const canApprove = Boolean(
    job?.parser_result && validation.state && validation.state.hero_cards.length > 0 && validation.state.street && !currentStateApproved,
  );
  const canRecommend = currentStateApproved && !job?.recommendation;
  const stateControlsDisabled = busy;
  const screenshotUrl = useMemo(() => (job && job.image_filename !== "" ? imageUrl(job.id) : null), [job]);
  const screenSharing = screenStream !== null;
  const confidenceSummary = useMemo(() => summarizeConfidences(confidences, warnings), [confidences, warnings]);
  const filmstripCount = jobs.length > 0 ? jobs.length : files.length;
  const frameLabel = job?.original_filename ?? (screenSharing ? `${screenSourceLabel ?? shareModeLabel(shareMode)} live preview` : "No table selected");
  const frameStreet = form.street === "" ? "No street" : form.street;
  const queueCount = jobs.length > 0 ? jobs.length : files.length;
  const liveStatusLabel = screenSharing ? `${screenSourceLabel ?? shareModeLabel(shareMode)} sharing` : inputMode === "upload" ? "Upload queue" : "Live capture";
  const queueProgressPercent = queueProgress ? Math.round((queueProgress.completed / queueProgress.total) * 100) : 0;
  const clearableJobs = useMemo(() => jobs.filter(isHistoryReady), [jobs]);
  const activeParserProvider = systemInfo?.parser_provider ?? job?.parser_provider ?? null;
  const activeRecommendationProvider =
    systemInfo?.recommendation_engine ?? systemInfo?.recommendation_provider ?? job?.recommendation_provider ?? null;

  function setError(nextError: string | null) {
    setErrorMessage(nextError);
    setErrorSequence((current) => current + 1);
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = screenStream;
    if (screenStream) {
      try {
        const playPromise = video.play();
        void playPromise?.catch?.(() => undefined);
      } catch {
        // Browsers can delay playback until the element is visible; capture still works once frames arrive.
      }
    }
  }, [screenStream]);

  useEffect(() => {
    if (!screenStream) {
      return;
    }

    const tracks = screenStream.getTracks();
    const onEnded = () => {
      setScreenStream((current) => (current === screenStream ? null : current));
      setScreenSourceLabel(null);
      setLivePreviewVisible(false);
    };
    tracks.forEach((track) => track.addEventListener("ended", onEnded));

    return () => {
      tracks.forEach((track) => {
        track.removeEventListener("ended", onEnded);
        track.stop();
      });
    };
  }, [screenStream]);

  useEffect(() => {
    if (error) {
      toast.error(error, { id: ERROR_TOAST_ID });
      return;
    }
    toast.dismiss(ERROR_TOAST_ID);
  }, [error, errorSequence]);

  useEffect(() => {
    if (job && validation.error) {
      toast.warning(validation.error, { id: VALIDATION_TOAST_ID });
      return;
    }
    toast.dismiss(VALIDATION_TOAST_ID);
  }, [job, validation.error]);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.target.files ?? []));
  }

  function activateJob(nextJob: JobRecord) {
    setActiveJobId(nextJob.id);
    const nextState = stateFromJob(nextJob);
    setForm(stateToForm(nextState));
    setApprovedStateKey(nextJob.approved_state ? approvalKey(nextJob.approved_state) : null);
    setLivePreviewVisible(false);
    setError(null);
  }

  function replaceJob(updatedJob: JobRecord) {
    setJobs((current) => current.map((candidate) => (candidate.id === updatedJob.id ? updatedJob : candidate)));
    setActiveJobId(updatedJob.id);
  }

  function appendJob(created: JobRecord) {
    setJobs((current) => [...current, created]);
    activateJob(created);
  }

  function saveHistoryJobs(nextJobs: JobRecord[]) {
    if (nextJobs.length === 0) {
      return;
    }

    const savedAt = new Date().toISOString();
    const items: HistoryItem[] = nextJobs.map((nextJob) => ({
      id: nextJob.id,
      job: nextJob,
      savedAt,
    }));
    const incomingIds = new Set(items.map((item) => item.id));

    setHistory((current) => {
      const next = [...items, ...current.filter((candidate) => !incomingIds.has(candidate.id))].slice(0, 24);
      writeHistory(next);
      return next;
    });
  }

  function applyApprovedJob(approved: JobRecord, fallbackState: CanonicalState) {
    const approvedState = approved.approved_state ?? { ...fallbackState, user_approved: true };
    replaceJob(approved);
    setForm(stateToForm(approvedState));
    setApprovedStateKey(approvalKey(approvedState));
  }

  function applyRecommendedJob(recommended: JobRecord) {
    replaceJob(recommended);
    if (recommended.approved_state) {
      setApprovedStateKey(approvalKey(recommended.approved_state));
    }
  }

  async function runConfiguredAutomation(created: JobRecord, signal?: AbortSignal): Promise<JobRecord> {
    if (!automationApprove) {
      return created;
    }
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const approvalState = autoApprovalState(created, automationAllowWarnings);
    const approved = await approveState(created.id, approvalState, signal);
    applyApprovedJob(approved, approvalState);

    if (!automationRecommend) {
      return approved;
    }

    const recommended = await requestRecommendation(approved.id, signal);
    applyRecommendedJob(recommended);
    return recommended;
  }

  async function uploadSelectedFiles(runAutomation: boolean): Promise<JobRecord[]> {
    const selectedFiles = [...files];
    const controller = new AbortController();
    queueAbortControllerRef.current = controller;
    queueAbortRequestedRef.current = false;
    setQueueProgress({
      total: selectedFiles.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      currentIndex: 0,
      currentFile: "",
      aborting: false,
    });

    const completedJobs: JobRecord[] = [];
    const attentionMessages: string[] = [];
    let completedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const [index, selectedFile] of selectedFiles.entries()) {
      if (controller.signal.aborted) {
        skippedCount = selectedFiles.length - completedCount;
        break;
      }
      setQueueProgress({
        total: selectedFiles.length,
        completed: completedCount,
        failed: failedCount,
        skipped: 0,
        currentIndex: index + 1,
        currentFile: selectedFile.name,
        aborting: false,
      });

      try {
        const created = await uploadScreenshot(selectedFile, controller.signal);
        appendJob(created);
        let completed = created;
        if (runAutomation) {
          try {
            completed = await runConfiguredAutomation(created, controller.signal);
          } catch (automationError) {
            if (isAbortError(automationError)) {
              completedJobs.push(created);
              completedCount += 1;
              skippedCount = selectedFiles.length - completedCount;
              break;
            }
            const message = messageFromError(automationError, "Automation stopped for this screenshot");
            const attentionJob = markJobNeedsAttention(created, message);
            replaceJob(attentionJob);
            completed = attentionJob;
            attentionMessages.push(`${selectedFile.name}: ${message}`);
            failedCount += 1;
          }
        }
        completedJobs.push(completed);
        completedCount += 1;
      } catch (uploadError) {
        if (isAbortError(uploadError)) {
          skippedCount = selectedFiles.length - completedCount;
          break;
        }
        const message = messageFromError(uploadError, "Upload failed");
        const errorJob = createLocalErrorJob(selectedFile, message, index);
        appendJob(errorJob);
        completedJobs.push(errorJob);
        attentionMessages.push(`${selectedFile.name}: ${message}`);
        completedCount += 1;
        failedCount += 1;
      }
      setQueueProgress({
        total: selectedFiles.length,
        completed: completedCount,
        failed: failedCount,
        skipped: skippedCount,
        currentIndex: Math.min(index + 1, selectedFiles.length),
        currentFile: selectedFile.name,
        aborting: controller.signal.aborted,
      });
    }
    if (completedJobs.length > 1) {
      activateJob(completedJobs[0]);
    }
    if (controller.signal.aborted || queueAbortRequestedRef.current) {
      setError(`Import aborted. ${skippedCount} unprocessed screenshot${skippedCount === 1 ? "" : "s"} discarded.`);
    } else if (attentionMessages.length > 0) {
      setError(`${attentionMessages.length} screenshot${attentionMessages.length === 1 ? "" : "s"} need attention. Check the highlighted queue items.`);
    }
    setFiles([]);
    setQueueProgress(null);
    queueAbortControllerRef.current = null;
    queueAbortRequestedRef.current = false;
    return completedJobs;
  }

  async function onUpload() {
    if (files.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await uploadSelectedFiles(automationEnabled);
    } catch (uploadError) {
      setError(messageFromError(uploadError, "Upload failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onStartScreenShare(mode: ShareMode = shareMode) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen sharing is not supported in this browser");
      return;
    }

    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(mode));
      const displaySurface = getDisplaySurface(stream);
      if (!displaySurfaceMatchesMode(displaySurface, mode)) {
        stopMediaStream(stream);
        setScreenSourceLabel(null);
        setScreenStream(null);
        setLivePreviewVisible(false);
        setError(wrongShareModeMessage(displaySurface, mode));
        return;
      }
      setScreenSourceLabel(displaySurfaceLabel(displaySurface) ?? shareModeLabel(mode));
      setScreenStream(stream);
      setLivePreviewVisible(true);
    } catch (shareError) {
      setError(messageFromError(shareError, "Screen sharing was cancelled"));
    }
  }

  function onStopScreenShare() {
    setScreenSourceLabel(null);
    setScreenStream(null);
    setLivePreviewVisible(false);
  }

  async function captureSharedScreenFile(): Promise<File> {
    const video = videoRef.current;
    if (!video || !screenStream) {
      throw new Error("Start screen sharing before capturing");
    }
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      throw new Error("Screen share is still loading; try capture again in a moment");
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not prepare screen capture");
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((capturedBlob) => {
        if (capturedBlob) {
          resolve(capturedBlob);
        } else {
          reject(new Error("Could not encode screen capture"));
        }
      }, "image/png");
    });
    return new File([blob], captureName(), { type: "image/png" });
  }

  async function captureAndParseScreen(): Promise<JobRecord> {
    const created = await uploadScreenshot(await captureSharedScreenFile());
    appendJob(created);
    return created;
  }

  async function onCaptureScreen() {
    setBusy(true);
    setError(null);
    try {
      const created = await captureAndParseScreen();
      if (automationEnabled) {
        await runConfiguredAutomation(created);
      }
    } catch (captureError) {
      setError(messageFromError(captureError, "Screen capture failed"));
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
      applyApprovedJob(approved, validation.state);
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
      applyRecommendedJob(await requestRecommendation(job.id));
    } catch (recommendError) {
      setError(messageFromError(recommendError, "Recommendation failed"));
    } finally {
      setBusy(false);
    }
  }

  function updateForm(field: keyof StateForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setApprovedStateKey(null);
    setJobs((current) => current.map((candidate) => (candidate.id === job?.id ? clearApprovedResult(candidate) : candidate)));
  }

  function resetToParser() {
    if (job?.parser_result) {
      setForm(stateToForm(job.parser_result.state));
      setError(null);
      setApprovedStateKey(null);
      setJobs((current) => current.map((candidate) => (candidate.id === job.id ? clearApprovedResult(candidate) : candidate)));
    }
  }

  function updateAutomationApprove(value: boolean) {
    setAutomationApprove(value);
    if (!value) {
      setAutomationRecommend(false);
    }
  }

  function openInfoDialog() {
    setInfoDialogOpen(true);
    if (systemInfo || systemInfoLoading) {
      return;
    }

    setSystemInfoLoading(true);
    void getSystemInfo()
      .then(setSystemInfo)
      .catch(() => undefined)
      .finally(() => setSystemInfoLoading(false));
  }

  function openBenchmarkDialog() {
    setBenchmarkDialogOpen(true);
    setBenchmarkLoading(true);
    void getBenchmarkOverview()
      .then(setBenchmarkOverview)
      .catch((benchmarkError) => setError(messageFromError(benchmarkError, "Could not load parser benchmark")))
      .finally(() => setBenchmarkLoading(false));
  }

  async function toggleBenchmarkInclusion() {
    if (!job || (!job.approved_state && !job.benchmark_included)) {
      return;
    }
    setBenchmarkUpdating(true);
    setError(null);
    try {
      const included = !job.benchmark_included;
      const updated = await setBenchmarkInclusion(job.id, included);
      replaceJob(updated);
      setBenchmarkOverview((current) =>
        current
          ? {
              ...current,
              included_cases: Math.max(0, current.included_cases + (included ? 1 : -1)),
            }
          : current,
      );
    } catch (benchmarkError) {
      setError(messageFromError(benchmarkError, "Could not update benchmark ground truth"));
    } finally {
      setBenchmarkUpdating(false);
    }
  }

  async function onRunBenchmark() {
    setBenchmarkRunning(true);
    setError(null);
    try {
      const latestReport = await runParserBenchmark();
      setBenchmarkOverview((current) => ({
        included_cases: current?.included_cases ?? latestReport.total_cases,
        latest_report: latestReport,
      }));
    } catch (benchmarkError) {
      setError(messageFromError(benchmarkError, "Parser benchmark failed"));
    } finally {
      setBenchmarkRunning(false);
    }
  }

  function onAbortQueue() {
    queueAbortRequestedRef.current = true;
    queueAbortControllerRef.current?.abort();
    setQueueProgress((current) =>
      current
        ? {
            ...current,
            aborting: true,
            skipped: Math.max(current.total - current.completed, 0),
          }
        : current,
    );
  }

  function openHistory(item: HistoryItem) {
    setJobs((current) => {
      const existing = current.some((candidate) => candidate.id === item.job.id);
      if (existing) {
        return current.map((candidate) => (candidate.id === item.job.id ? item.job : candidate));
      }
      return [item.job, ...current];
    });
    activateJob(item.job);
  }

  function clearReviewedToHistory() {
    const readyJobs = jobs.filter(isHistoryReady);
    if (readyJobs.length === 0) {
      return;
    }

    const remainingJobs = jobs.filter((candidate) => !isHistoryReady(candidate));
    saveHistoryJobs(readyJobs);
    setJobs(remainingJobs);
    if (remainingJobs.length > 0) {
      activateJob(remainingJobs.find((candidate) => candidate.id === activeJobId) ?? remainingJobs[0]);
    } else {
      setActiveJobId(null);
      setForm(stateToForm(EMPTY_STATE));
      setApprovedStateKey(null);
      setError(null);
    }
  }

  return (
    <main className="app-shell">
      <Toaster
        closeButton
        containerAriaLabel="App notifications"
        expand={false}
        offset={{ right: 18, top: 88 }}
        position="top-right"
        richColors
        toastOptions={{
          classNames: {
            closeButton: "app-toast-close",
            error: "app-toast-error",
            title: "app-toast-title",
            toast: "app-toast",
            warning: "app-toast-warning",
          },
          duration: 6000,
        }}
      />
      <section className="toolbar" aria-label="Analyzer controls">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            A
          </div>
          <div>
            <h1>Poker Training Analyzer</h1>
            <p>Post-hand review for Texas Hold&apos;em screenshots</p>
          </div>
        </div>
        <div className="toolbar-stats" aria-label="Session status">
          <div className="toolbar-stat">
            <strong>{queueCount}</strong>
            <span>in queue</span>
          </div>
          <i aria-hidden="true" />
          <div className="toolbar-stat">
            <strong>{history.length}</strong>
            <span>reviewed</span>
          </div>
          <div className={screenSharing ? "source-status active" : "source-status"}>
            <span aria-hidden="true" />
            <strong>{liveStatusLabel}</strong>
          </div>
          <i aria-hidden="true" />
          <div className="automation-header-control">
            <button
              type="button"
              className={automationEnabled ? "automation-master active" : "automation-master"}
              onClick={() => setAutomationEnabled((current) => !current)}
              aria-pressed={automationEnabled}
              aria-label={`Automation ${automationEnabled ? "On" : "Off"}`}
            >
              <span className="switch-mini" aria-hidden="true">
                <span />
              </span>
              <span className="automation-master-text">
                <strong>Automation</strong>
                <span>{automationEnabled ? "On" : "Off"}</span>
              </span>
            </button>
            <button type="button" className="automation-config-button" onClick={() => setAutomationDialogOpen(true)} aria-label="Configure automation">
              <Settings size={17} aria-hidden="true" />
            </button>
          </div>
          <button type="button" className="header-icon-button" onClick={openInfoDialog} title="About this app" aria-label="About this app">
            <Info size={18} aria-hidden="true" />
          </button>
          <button type="button" className="header-icon-button" onClick={openBenchmarkDialog} title="Parser benchmark" aria-label="Parser benchmark">
            <FlaskConical size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="app-workspace">
        <aside className="control-rail" aria-label="Capture, queue and history">
          <section className="input-panel">
            <div className="input-panel-heading">
              <h2>Input</h2>
              <div className="input-mode-switch" role="group" aria-label="Input mode">
                <button type="button" className={inputMode === "live" ? "active" : ""} onClick={() => setInputMode("live")} disabled={busy} aria-pressed={inputMode === "live"}>
                  Live
                </button>
                <button type="button" className={inputMode === "upload" ? "active" : ""} onClick={() => setInputMode("upload")} disabled={busy} aria-pressed={inputMode === "upload"}>
                  Upload
                </button>
              </div>
            </div>

            <div className="input-source-body">
              {inputMode === "live" ? (
                <>
                  <span className="input-label">Capture source</span>
                  <div className="share-mode" role="group" aria-label="Share source type">
                    {SHARE_MODES.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={shareMode === option.value ? "active" : ""}
                        onClick={() => setShareMode(option.value)}
                        disabled={screenSharing || busy}
                        aria-pressed={shareMode === option.value}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <div className="screen-capture-actions">
                    <button
                      type="button"
                      className="secondary-button share-source-button"
                      onClick={() => (screenSharing ? setLivePreviewVisible(true) : onStartScreenShare())}
                      disabled={busy || (screenSharing && livePreviewVisible)}
                    >
                      <span className={screenSharing ? "source-indicator active" : "source-indicator"} aria-hidden="true" />
                      {screenSharing ? `View live ${shareModeLabel(shareMode).toLowerCase()}` : `Share ${shareModeLabel(shareMode).toLowerCase()}`}
                    </button>
                    <button type="button" className="secondary-button icon-action" onClick={onCaptureScreen} disabled={!screenSharing || busy} title="Capture and parse" aria-label="Capture and parse">
                      <Camera size={15} aria-hidden="true" />
                    </button>
                    <button type="button" className="secondary-button icon-action" onClick={onStopScreenShare} disabled={!screenSharing || busy} title="Stop sharing" aria-label="Stop sharing">
                      <Square size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="source-hint">{screenSharing ? `${screenSourceLabel ?? "Source"} sharing active` : "Pick a source and share to read frames."}</div>
                </>
              ) : (
                <>
                  <span className="input-label">Screenshot files</span>
                  <div className="upload-source-row">
                    <label className="file-picker">
                      <Upload size={15} aria-hidden="true" />
                      <span>{selectedFilesLabel(files)}</span>
                      <input className="file-input" type="file" accept="image/*" multiple aria-label="Choose screenshots" onChange={onFileChange} />
                    </label>
                    <button type="button" className="secondary-button icon-action" onClick={onUpload} disabled={files.length === 0 || busy} title="Upload and parse" aria-label="Upload and parse">
                      <Upload size={15} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="source-hint">{files.length > 0 ? `${files.length} selected for upload` : "Choose screenshots to add them to the queue."}</div>
                </>
              )}
            </div>
          </section>

          <section className="queue-panel" aria-label="Screenshots queue">
            <div className="rail-section-heading">
              <span>Queued frames</span>
              <span className="sr-only">{filmstripCount} screenshots</span>
              <span className="queue-heading-actions">
                <strong>{filmstripCount}</strong>
                <button
                  type="button"
                  className="clear-reviewed-button"
                  onClick={clearReviewedToHistory}
                  disabled={busy || clearableJobs.length === 0}
                  title="Clear reviewed to history"
                  aria-label="Clear reviewed"
                >
                  <Archive size={13} aria-hidden="true" />
                </button>
              </span>
            </div>
            {jobs.length > 0 ? (
              <div className="batch-list">
                {jobs.map((candidate, index) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={candidate.id === job?.id ? "batch-item active" : "batch-item"}
                    onClick={() => activateJob(candidate)}
                    disabled={busy}
                    aria-label={`Open screenshot ${index + 1}: ${candidate.original_filename}`}
                  >
                    <span className="batch-number">{index + 1}</span>
                    <span className="batch-text">
                      <span>{candidate.original_filename}</span>
                      <small>{queueDetail(candidate)}</small>
                    </span>
                    <StatusPill status={candidate.status} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="pending-files">{files.length > 0 ? selectedFilesLabel(files) : "No screenshots uploaded or captured yet"}</div>
            )}
          </section>

          <section className="history-panel" aria-label="Session history">
            <div className="rail-section-heading history-heading">
              <span>History · reopen</span>
              <span className="autosaved-pill">Auto-saved</span>
            </div>
            {history.length > 0 ? (
              <div className="history-list">
                {history.map((item, index) => {
                  const cards = historyCards(item.job);
                  return (
                    <button key={`${item.id}-${item.savedAt}`} type="button" className="history-item" onClick={() => openHistory(item)} aria-label={`Reopen history item ${index + 1}`}>
                      <span className="history-cards">
                        {cards.length > 0 ? (
                          cards.map((card) => (
                            <span key={cardToCode(card)} className={isRedSuit(card) ? "red-card" : ""}>
                              {cardToDisplay(card)}
                            </span>
                          ))
                        ) : (
                          <small>No cards</small>
                        )}
                      </span>
                      <span className="history-meta">
                        <small>{relativeTimeLabel(item.savedAt)}</small>
                        <strong>{historyAction(item.job)}</strong>
                      </span>
                      <span className="history-result">{item.job.recommendation ? `${Math.round(item.job.recommendation.confidence * 100)}%` : item.job.status.slice(0, 1).toUpperCase()}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="history-empty">Cleared reviewed hands will appear here.</div>
            )}
          </section>
        </aside>

        <section className="table-column" aria-label="Poker table preview">
          <div className="table-frame-bar">
            <span className={screenSharing ? "live-dot active" : "live-dot"} aria-hidden="true" />
            <span>{frameLabel}</span>
            <strong>{frameStreet}</strong>
          </div>
          <div className="table-frame-body">
            <video className={screenSharing && livePreviewVisible ? "shared-preview active" : "shared-preview"} ref={videoRef} muted playsInline aria-label="Shared screen preview" />
            {screenshotUrl ? <img className={screenSharing && livePreviewVisible ? "screenshot-preview hidden" : "screenshot-preview"} src={screenshotUrl} alt="Uploaded poker table screenshot" /> : null}
            {(!screenSharing || !livePreviewVisible) && !screenshotUrl ? <div className="empty-screenshot">No screenshot uploaded</div> : null}
          </div>
          <div className="confidence-summary" aria-label="Parser confidence summary">
            <div>
              <strong>
                {confidenceSummary.detectedCount}
                <span>/{confidenceSummary.fieldTotal}</span>
              </strong>
              <small>fields read</small>
            </div>
            <div>
              <strong>{confidenceSummary.averageConfidence}%</strong>
              <small>avg confidence</small>
            </div>
            <div>
              <strong className={confidenceSummary.reviewCount > 0 ? "needs-review" : ""}>{confidenceSummary.reviewCount}</strong>
              <small>need review</small>
            </div>
          </div>
        </section>

        <section className="review-column" aria-label="Hand review">
          <div className="panel-header">
            <h2>Detected state</h2>
            {job ? <StatusPill status={job.status} /> : null}
          </div>

          <div className="review-scroll">
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
              <Field label="Hero cards" confidence={confidenceLabel(confidences.hero_cards)} confidenceValue={confidences.hero_cards}>
                <input disabled={stateControlsDisabled} value={form.hero_cards} onChange={(event) => updateForm("hero_cards", event.target.value)} />
              </Field>
              <Field label="Board cards" confidence={confidenceLabel(confidences.board_cards)} confidenceValue={confidences.board_cards}>
                <input disabled={stateControlsDisabled} value={form.board_cards} onChange={(event) => updateForm("board_cards", event.target.value)} />
              </Field>
              <Field label="Street" confidence={confidenceLabel(confidences.street)} confidenceValue={confidences.street}>
                <select disabled={stateControlsDisabled} value={form.street} onChange={(event) => updateForm("street", event.target.value)}>
                  <option value="">Select street</option>
                  <option value="preflop">Preflop</option>
                  <option value="flop">Flop</option>
                  <option value="turn">Turn</option>
                  <option value="river">River</option>
                </select>
              </Field>
              <Field label="Pot" confidence={confidenceLabel(confidences.pot_size)} confidenceValue={confidences.pot_size}>
                <input disabled={stateControlsDisabled} inputMode="decimal" value={form.pot_size} onChange={(event) => updateForm("pot_size", event.target.value)} />
              </Field>
              <Field label="Current bet" confidence={confidenceLabel(confidences.current_bet)} confidenceValue={confidences.current_bet}>
                <input
                  disabled={stateControlsDisabled}
                  inputMode="decimal"
                  value={form.current_bet}
                  onChange={(event) => updateForm("current_bet", event.target.value)}
                />
              </Field>
              <Field label="Effective stack" confidence={confidenceLabel(confidences.effective_stack)} confidenceValue={confidences.effective_stack}>
                <input
                  disabled={stateControlsDisabled}
                  inputMode="decimal"
                  value={form.effective_stack}
                  onChange={(event) => updateForm("effective_stack", event.target.value)}
                />
              </Field>
              <Field label="Hero stack" confidence={confidenceLabel(confidences.hero_stack)} confidenceValue={confidences.hero_stack}>
                <input
                  disabled={stateControlsDisabled}
                  inputMode="decimal"
                  value={form.hero_stack}
                  onChange={(event) => updateForm("hero_stack", event.target.value)}
                />
              </Field>
              <Field label="Players in hand" confidence={confidenceLabel(confidences.players_in_hand)} confidenceValue={confidences.players_in_hand}>
                <input
                  disabled={stateControlsDisabled}
                  inputMode="numeric"
                  value={form.players_in_hand}
                  onChange={(event) => updateForm("players_in_hand", event.target.value)}
                />
              </Field>
              <Field label="Hero position" confidence={confidenceLabel(confidences.hero_position)} confidenceValue={confidences.hero_position}>
                <input disabled={stateControlsDisabled} value={form.hero_position} onChange={(event) => updateForm("hero_position", event.target.value)} />
              </Field>
              <Field label="Facing action" confidence={confidenceLabel(confidences.facing_action)} confidenceValue={confidences.facing_action}>
                <select disabled={stateControlsDisabled} value={form.facing_action} onChange={(event) => updateForm("facing_action", event.target.value)}>
                  <option value="">Select action</option>
                  <option value="bet">Bet</option>
                  <option value="raise">Raise or check-raise</option>
                </select>
              </Field>
              <Field label="Action context" confidence={confidenceLabel(confidences.action_context)} confidenceValue={confidences.action_context}>
                <textarea disabled={stateControlsDisabled} value={form.action_context} onChange={(event) => updateForm("action_context", event.target.value)} />
              </Field>
            </div>

            {currentStateApproved && job?.recommendation ? (
              <section className="recommendation" aria-label="Recommendation">
                <div className="recommendation-head">
                  <span>Recommended play</span>
                  <strong>{Math.round(job.recommendation.confidence * 100)}% confidence</strong>
                </div>
                <div className="recommendation-main">
                  <span className="recommendation-action">{job.recommendation.action}</span>
                  {job.recommendation.sizing !== null ? <span className="recommendation-sizing">{job.recommendation.sizing}</span> : null}
                </div>
                <p>{job.recommendation.explanation}</p>
              </section>
            ) : null}
          </div>

          <div className="review-actions">
            <button type="button" onClick={onApprove} disabled={!canApprove || busy} aria-label="Approve state">
              <Check size={15} aria-hidden="true" />
              Approve
            </button>
            <button type="button" className="secondary-button" onClick={onRecommend} disabled={!canRecommend || busy} aria-label="Request recommendation">
              <Play size={14} aria-hidden="true" />
              Recommend
            </button>
            <button type="button" className="ghost-button icon-action" onClick={resetToParser} disabled={!job?.parser_result || busy} title="Reset to parser" aria-label="Reset to parser">
              <RefreshCcw size={14} aria-hidden="true" />
            </button>
          </div>
        </section>
      </section>

      {queueProgress ? (
        <section className="processing-backdrop">
          <div className="processing-dialog" role="dialog" aria-modal="true" aria-labelledby="processing-dialog-title">
            <div className="processing-header">
              <div>
                <h2 id="processing-dialog-title">{queueProgress.aborting ? "Stopping import" : "Processing queue"}</h2>
                <p>
                  {queueProgress.currentIndex > 0 ? `Screenshot ${queueProgress.currentIndex} of ${queueProgress.total}` : `Preparing ${queueProgress.total} screenshots`}
                </p>
              </div>
              <strong>{queueProgressPercent}%</strong>
            </div>

            <div className="processing-progress" aria-hidden="true">
              <span style={{ width: `${queueProgressPercent}%` }} />
            </div>

            <div className="processing-current">
              <span>{queueProgress.aborting ? "Discarding unprocessed screenshots" : "Current screenshot"}</span>
              <strong>{queueProgress.currentFile || "Preparing queue"}</strong>
            </div>

            <div className="processing-stats">
              <div>
                <strong>{queueProgress.completed}</strong>
                <span>processed</span>
              </div>
              <div>
                <strong>{queueProgress.failed}</strong>
                <span>attention</span>
              </div>
              <div>
                <strong>{queueProgress.skipped}</strong>
                <span>discarded</span>
              </div>
            </div>

            <button type="button" className="secondary-button" onClick={onAbortQueue} disabled={queueProgress.aborting}>
              <Square size={13} aria-hidden="true" />
              Abort and discard unprocessed
            </button>
          </div>
        </section>
      ) : null}

      {automationDialogOpen ? (
        <section className="modal-backdrop">
          <div className="automation-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-dialog-title">
            <div className="automation-dialog-header">
              <div>
                <h2 id="automation-dialog-title">Configure automation</h2>
                <p>Applies to every frame you capture or upload</p>
              </div>
              <button type="button" className="dialog-icon-button" onClick={() => setAutomationDialogOpen(false)} aria-label="Close automation settings">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="automation-dialog-body">
              <AutomationToggle
                title="Auto-approve parsed state"
                description="Skip manual review when confidence is high"
                checked={automationApprove}
                onToggle={() => updateAutomationApprove(!automationApprove)}
              />
              <AutomationToggle
                title="Auto-request recommendation"
                description="Generate a play the moment a frame is approved"
                checked={automationRecommend}
                disabled={!automationApprove}
                onToggle={() => setAutomationRecommend((current) => !current)}
              />
              <AutomationToggle
                title="Allow parser warnings"
                description="Continue automation even when fields are flagged"
                checked={automationAllowWarnings}
                disabled={!automationApprove}
                onToggle={() => setAutomationAllowWarnings((current) => !current)}
              />
            </div>

            <div className="automation-dialog-footer">
              <span>
                Master automation is <strong>{automationEnabled ? "On" : "Off"}</strong>
              </span>
              <button type="button" className="secondary-button" onClick={() => setAutomationDialogOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {infoDialogOpen ? (
        <section className="modal-backdrop">
          <div className="automation-dialog info-dialog" role="dialog" aria-modal="true" aria-labelledby="info-dialog-title">
            <div className="automation-dialog-header">
              <div>
                <h2 id="info-dialog-title">About Poker Training Analyzer</h2>
                <p>Post-hand Texas Hold&apos;em review and training</p>
              </div>
              <button type="button" className="dialog-icon-button" onClick={() => setInfoDialogOpen(false)} aria-label="Close app information">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="info-dialog-body">
              <section className="info-dialog-section active-engines">
                <h3>Currently active</h3>
                {activeParserProvider && activeRecommendationProvider ? (
                  <div className="info-provider-grid">
                    <div>
                      <small>Recognition</small>
                      <strong>{providerLabel(activeParserProvider)}</strong>
                    </div>
                    <div>
                      <small>Recommendation</small>
                      <strong>{providerLabel(activeRecommendationProvider)}</strong>
                    </div>
                  </div>
                ) : (
                  <p>{systemInfoLoading ? "Reading backend configuration..." : "Active engine details are unavailable."}</p>
                )}
              </section>
              <section className="info-dialog-section">
                <h3>Recognition</h3>
                <p>OCR and computer vision read the cards, board, pot, bets, stacks, and table state from each screenshot. Confidence scores identify fields that need review.</p>
              </section>
              <section className="info-dialog-section">
                <h3>Recommendations</h3>
                <p>The configured engine analyzes approved hand state and compares available actions. The postflop engine solves heads-up game trees; unsupported spots use the range/EV fallback.</p>
              </section>
              <section className="info-dialog-section">
                <h3>Training scope</h3>
                <p>Designed for post-hand study. It does not place bets or interact directly with a poker client.</p>
              </section>
            </div>

            <div className="automation-dialog-footer info-dialog-footer">
              <button type="button" className="secondary-button" onClick={() => setInfoDialogOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {benchmarkDialogOpen ? (
        <section className="modal-backdrop">
          <div className="automation-dialog benchmark-dialog" role="dialog" aria-modal="true" aria-labelledby="benchmark-dialog-title">
            <div className="automation-dialog-header">
              <div>
                <h2 id="benchmark-dialog-title">Parser benchmark</h2>
                <p>
                  {benchmarkOverview?.latest_report
                    ? `${providerLabel(benchmarkOverview.latest_report.parser_provider)} · ${benchmarkOverview.latest_report.layout_profile}`
                    : "Ground-truth recognition checks"}
                </p>
              </div>
              <button type="button" className="dialog-icon-button" onClick={() => setBenchmarkDialogOpen(false)} aria-label="Close parser benchmark">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="benchmark-dialog-body">
              <button
                type="button"
                className="automation-toggle-row benchmark-ground-truth"
                role="switch"
                aria-checked={job?.benchmark_included ?? false}
                onClick={toggleBenchmarkInclusion}
                disabled={(!job?.approved_state && !job?.benchmark_included) || benchmarkUpdating}
              >
                <span>
                  <strong>Use current hand as ground truth</strong>
                  <small>
                    {job?.approved_state
                      ? job.original_filename
                      : job?.benchmark_included
                        ? "Previous approved state remains included"
                        : "Approve the current hand first"}
                  </small>
                </span>
                <span className={job?.benchmark_included ? "switch-control active" : "switch-control"} aria-hidden="true">
                  <span />
                </span>
              </button>

              {benchmarkLoading ? (
                <div className="benchmark-empty">Reading benchmark results...</div>
              ) : benchmarkOverview?.latest_report ? (
                <>
                  <div className="benchmark-summary" aria-label="Latest benchmark summary">
                    <div>
                      <strong>{benchmarkOverview.latest_report.total_cases}</strong>
                      <span>cases</span>
                    </div>
                    <div>
                      <strong>{benchmarkOverview.latest_report.correct_fields}/{benchmarkOverview.latest_report.evaluated_fields}</strong>
                      <span>fields correct</span>
                    </div>
                    <div>
                      <strong>{benchmarkPercent(benchmarkOverview.latest_report.accuracy)}</strong>
                      <span>accuracy</span>
                    </div>
                    <div>
                      <strong className={benchmarkOverview.latest_report.failed_cases > 0 ? "needs-review" : ""}>{benchmarkOverview.latest_report.failed_cases}</strong>
                      <span>failed</span>
                    </div>
                  </div>

                  <div className="benchmark-results-scroll">
                    <section className="benchmark-result-section" aria-labelledby="benchmark-fields-title">
                      <h3 id="benchmark-fields-title">Field accuracy</h3>
                      <div className="benchmark-field-list">
                        {benchmarkOverview.latest_report.field_metrics.map((metric) => (
                          <div key={metric.field}>
                            <span>{benchmarkFieldLabel(metric.field)}</span>
                            <small>{metric.correct}/{metric.total}</small>
                            <strong>{benchmarkPercent(metric.accuracy)}</strong>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section className="benchmark-result-section" aria-labelledby="benchmark-cases-title">
                      <h3 id="benchmark-cases-title">Cases</h3>
                      <div className="benchmark-case-list">
                        {benchmarkOverview.latest_report.cases.map((benchmarkCase) => (
                          <div key={benchmarkCase.job_id}>
                            <span>
                              <strong>{benchmarkCase.original_filename}</strong>
                              <small>{benchmarkCase.error ?? `${benchmarkCase.correct_fields}/${benchmarkCase.evaluated_fields} fields`}</small>
                            </span>
                            <strong className={benchmarkCase.status === "error" ? "needs-review" : ""}>
                              {benchmarkCase.status === "error" ? "Error" : benchmarkPercent(benchmarkCase.accuracy)}
                            </strong>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                </>
              ) : (
                <div className="benchmark-empty">No benchmark has been run yet.</div>
              )}
            </div>

            <div className="automation-dialog-footer benchmark-dialog-footer">
              <span>
                <strong>{benchmarkOverview?.included_cases ?? 0}</strong> ground-truth {benchmarkOverview?.included_cases === 1 ? "hand" : "hands"}
              </span>
              <button
                type="button"
                onClick={onRunBenchmark}
                disabled={benchmarkLoading || benchmarkRunning || (benchmarkOverview?.included_cases ?? 0) === 0}
              >
                <Play size={14} aria-hidden="true" />
                {benchmarkRunning ? "Running..." : "Run benchmark"}
              </button>
              <button type="button" className="secondary-button" onClick={() => setBenchmarkDialogOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function AutomationToggle({
  title,
  description,
  checked,
  disabled = false,
  onToggle,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className="automation-toggle-row" role="switch" aria-checked={checked} onClick={onToggle} disabled={disabled}>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={checked ? "switch-control active" : "switch-control"} aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

function Field({ label, confidence, confidenceValue, children }: { label: string; confidence: string; confidenceValue?: number; children: ReactNode }) {
  const percent = confidencePercent(confidenceValue);
  const tone = confidenceTone(confidenceValue);
  return (
    <label className={`field field-${tone}`}>
      <span className="field-header">
        <span>{label}</span>
        <small>{confidence}</small>
      </span>
      {children}
      <span className="confidence-track" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
    </label>
  );
}

function StatusPill({ status }: { status: JobRecord["status"] }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}
