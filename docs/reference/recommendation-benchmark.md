# Recommendation Benchmark Format

The offline recommendation benchmark compares any configured recommendation
provider with a reviewed reference policy. Reference data should come from a
trusted solver export or an independently reviewed strategy source. Do not
generate the reference with the same provider being evaluated.

## Run A Corpus

```bash
pnpm backend:recommendation-benchmark ./recommendation-benchmark.json \
  --provider local_solver \
  --minimum-action-accuracy 0.90 \
  --minimum-line-accuracy 0.80 \
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
  "schema_version": 1,
  "name": "Reviewed heads-up flop sample",
  "sizing_tolerance_bb": 0.01,
  "minimum_policy_frequency": 0.05,
  "cases": [
    {
      "id": "btn-vs-bb-flop-001",
      "description": "Button checks or bets half pot on a dry flop",
      "state": {
        "hero_cards": [
          { "rank": "A", "suit": "hearts" },
          { "rank": "K", "suit": "diamonds" }
        ],
        "board_cards": [
          { "rank": "Q", "suit": "spades" },
          { "rank": "7", "suit": "clubs" },
          { "rank": "2", "suit": "hearts" }
        ],
        "pot_size": 10.0,
        "current_bet": 0.0,
        "hero_stack": 95.0,
        "effective_stack": 95.0,
        "players_in_hand": 2,
        "hero_position": "button",
        "preflop_opener_position": null,
        "preflop_open_size": null,
        "street": "flop",
        "facing_action": null,
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
- A provider exception or missing required canonical field fails only that case.
- A non-empty `raw.fallback_reason` counts toward fallback rate;
  `routing_reason` does not.

The corpus is limited to 1,000 cases and 4 MiB. Unknown fields, coerced schema
versions, duplicate IDs or line identities, partial EV labels, and ambiguous
wager sizes are rejected before the provider is called.
