export function formatCandidateValue(value: number): string {
  return Number(value.toFixed(3)).toString();
}

export function benchmarkPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatEvLossBb(value: number): string {
  return `${formatCandidateValue(value)} BB`;
}

export function formatAccuracyDelta(value: number): string {
  const points = Math.round(value * 100);
  return `${points > 0 ? "+" : ""}${points} pts`;
}

export function formatEvLossDeltaBb(value: number): string {
  return `${value > 0 ? "+" : ""}${formatCandidateValue(value)} BB`;
}

export function trainingTrendTone(
  delta: number,
  lowerIsBetter = false,
): "improving" | "declining" | "neutral" {
  const improvement = lowerIsBetter ? -delta : delta;
  if (improvement > 0) {
    return "improving";
  }
  if (improvement < 0) {
    return "declining";
  }
  return "neutral";
}
