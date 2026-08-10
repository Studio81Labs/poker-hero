# ADR 0040: Route Parser Plugins Automatically

## Status

Accepted

## Context

Users can select a parser provider and table layout for each upload, but a
deployment that supports both calibrated local OCR and external multi-layout
vision still requires the user to choose the provider manually. Selecting local
OCR for an incompatible capture now fails safely, but it leaves the frame in an
error state even when external vision is installed and could parse it.

Automatic routing must not present local OCR as a generic client detector. A
fixed-coordinate parser can only claim layouts with registered calibration, and
an automatic option must remain honest when no general fallback is configured.

## Decision

Register `auto` as a parser plugin. It requires the external vision endpoint to
be configured before the deployment advertises it as available.

For an explicit client layout registered by local OCR, `auto` tries `ocr_cv`
first. If local OCR raises a parser error, including a capture-geometry
rejection, it tries `llm_vision`. For any other enabled layout, it routes
directly to `llm_vision`. The legacy `generic` alias routes externally because
it does not prove that the capture is Fortuna/Nations. Automatic routing does
not infer a client from pixels or silently change the user-selected layout
profile.

Successful results retain the underlying provider output and add trusted
`parser_routing` evidence with the selected provider, layout, and any fallback
reason. A successful fallback does not add a parser warning because routing is
an implementation detail rather than a field-quality problem. If both routes
fail, the user receives one human-readable error containing both causes.

## Consequences

- Private deployments can expose one recognition choice across calibrated and
  external-only table layouts.
- Local OCR remains the fast first choice for its registered layouts.
- Unknown clients still require an explicit layout ID and external vision; this
  decision does not claim visual client detection.
- Local-only deployments continue to select `ocr_cv` directly and do not see an
  unusable automatic option.
- Routing evidence makes benchmark and support results attributable to the
  parser that actually handled each screenshot.
