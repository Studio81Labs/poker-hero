# Recommendation Benchmark Format

The offline recommendation benchmark compares any configured recommendation
provider with a reviewed reference policy. Reference data should come from a
trusted solver export or an independently reviewed strategy source. Do not
generate the reference with the same provider being evaluated.

## Run A Corpus

```bash
pnpm backend:recommendation-benchmark ./recommendation-benchmark.json \
  --provider local_solver \
  --require-reference-source \
  --minimum-action-accuracy 0.90 \
  --minimum-line-accuracy 0.80 \
  --minimum-line-coverage 0.90 \
  --minimum-policy-coverage 0.90 \
  --minimum-ev-coverage 0.90 \
  --minimum-conditioning-accuracy 1.00 \
  --minimum-conditioning-coverage 1.00 \
  --minimum-range-source-accuracy 1.00 \
  --minimum-range-source-coverage 1.00 \
  --maximum-policy-distance 0.15 \
  --maximum-ev-loss 0.05 \
  --maximum-fallback-rate 0.20
```

Add `--json` for the complete machine-readable report. The command exits with
status `1` when a provider case fails or a configured threshold is missed, and
status `2` when the corpus or provider configuration is invalid.

## Corpus Schema

```json
{
  "schema": "poker-hero-recommendation-benchmark",
  "schema_version": 4,
  "name": "Reviewed heads-up turn sample",
  "reference_source": {
    "name": "Independent solver export",
    "version": "2026.08",
    "configuration": "Heads-up cash, 100 BB, no rake"
  },
  "sizing_tolerance_bb": 0.01,
  "minimum_policy_frequency": 0.05,
  "cases": [
    {
      "id": "btn-vs-bb-turn-001",
      "description": "Button checks or bets half pot after a checked flop",
      "tags": [
        "single-raised-pot",
        "in-position",
        "range-conditioning",
        "range-source"
      ],
      "expected_range_conditioning": "applied",
      "expected_range_source": "preflop_chart_single_raised_pot",
      "state": {
        "hero_cards": [
          { "rank": "A", "suit": "hearts" },
          { "rank": "K", "suit": "diamonds" }
        ],
        "board_cards": [
          { "rank": "Q", "suit": "spades" },
          { "rank": "7", "suit": "clubs" },
          { "rank": "2", "suit": "hearts" },
          { "rank": "4", "suit": "diamonds" }
        ],
        "pot_size": 5.5,
        "current_bet": 0.0,
        "hero_stack": 97.5,
        "opponent_stack": 97.5,
        "effective_stack": 97.5,
        "players_in_hand": 2,
        "hero_position": "button",
        "opponent_position": "big_blind",
        "preflop_opener_position": "button",
        "preflop_open_size": 2.5,
        "preflop_action_history": [
          { "actor": "button", "action": "raise", "amount": 2.5 },
          { "actor": "big_blind", "action": "call", "amount": 2.5 }
        ],
        "street": "turn",
        "facing_action": null,
        "completed_postflop_streets": [
          {
            "street": "flop",
            "actions": [
              { "actor": "oop", "action": "check", "amount": null },
              { "actor": "ip", "action": "check", "amount": null }
            ]
          }
        ],
        "action_context": "Checked to hero",
        "user_approved": true
      },
      "reference_lines": [
        {
          "action": "check",
          "sizing": null,
          "frequency": 0.4,
          "ev_bb": 4.8
        },
        {
          "action": "bet",
          "sizing": 5.0,
          "frequency": 0.6,
          "ev_bb": 4.9
        }
      ]
    }
  ]
}
```

The values above illustrate the file shape and are not strategy claims.

## Evaluation Rules

- Reference frequencies are strict finite JSON numbers and sum to `1.0` per case.
- `reference_source` records the independent solver or reviewed strategy source.
  Version-1 corpora without provenance or tags and version-2 corpora without
  range-conditioning expectations remain readable. Version-3 corpora without
  range-source expectations also remain readable; new corpora use version 4.
  Use `--require-reference-source` for trusted regression runs.
- Lowercase case tags classify scenarios such as `single-raised-pot` and
  `facing-bet`. Reports include deterministic street and tag breakdowns; a case
  may contribute to more than one tag.
- Lines at or above `minimum_policy_frequency` count as supported strategy.
- Action agreement ignores sizing; line agreement uses `sizing_tolerance_bb`.
- The sizing boundary is strict: a difference exactly equal to the tolerance
  is not a match.
- A bet or raise may omit reference sizing for action-only evaluation. Such a
  case is excluded from line accuracy.
- If one line has `ev_bb`, every line in that case must have it. EV loss is the
  best reference EV minus the selected reference line EV.
- Policy distance is total-variation distance and is available only when the
  provider returns a complete valid `raw.candidates` frequency distribution.
  Four-decimal provider frequencies are normalized when their total differs
  from one only by bounded rounding error. Zero-frequency candidates do not
  require sizing because they contribute no policy mass.
- A provider exception or missing required canonical field fails only that case.
- A non-empty `raw.fallback_reason` counts toward fallback rate;
  `routing_reason` does not.
- Turn and river cases may declare `expected_range_conditioning` as `applied` or
  `skipped`. The benchmark compares it with
  `raw.range_conditioning.status`; an absent or malformed status lowers evidence
  coverage, while a recognized wrong status lowers agreement. The conditioning
  accuracy and coverage thresholds make both regressions fail explicitly.
- Flop, turn, and river cases may declare `expected_range_source` as
  `configured` or one of the `preflop_chart_*_pot` sources emitted by the local
  postflop solver. The benchmark compares the exact value with
  `raw.range_source`. A missing, malformed, or unknown source lowers evidence
  coverage; a recognized but incorrect source lowers agreement. Use
  `--minimum-range-source-accuracy` and `--minimum-range-source-coverage` to
  make either regression fail the run.
- Line, policy, and EV coverage report how many completed cases supplied enough
  evidence for each optional metric. Their minimum thresholds prevent missing
  sizes, frequencies, or EV labels from making a partial result look healthy.

The corpus is limited to 1,000 cases and 4 MiB. Unknown fields, coerced schema
versions, duplicate IDs or line identities, partial EV labels, and ambiguous
wager sizes are rejected before the provider is called.
