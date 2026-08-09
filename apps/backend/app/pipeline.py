from __future__ import annotations

from collections.abc import Iterable

from app.config import (
    KNOWN_LOCAL_SOLVER_ENGINES,
    KNOWN_RECOMMENDATION_PROVIDERS,
    Settings,
)
from app.models import PipelineCapabilities, PipelineOption, PipelineSelection
from app.parsers.registry import PARSER_PLUGINS, PARSER_PLUGIN_IDS, get_parser_plugin

LAYOUT_LABELS = {
    "generic": "Generic",
    "fortuna": "Fortuna",
    "nations": "Nations",
    "fortuna_nations": "Fortuna / Nations",
    "pokerstars": "PokerStars",
}
RECOMMENDATION_LABELS = {
    "rule_based": "Rule-based training",
    "mock": "Mock recommendation",
    "local_solver": "Local solver",
    "external_solver": "External solver",
    "llm_advice": "LLM advice",
}
ENGINE_LABELS = {
    "local_ev": "Local EV",
    "postflop_solver": "Postflop CFR",
    "custom_local": "Custom local solver",
}


class PipelineSelectionError(ValueError):
    pass


def _enabled(default: str, configured: Iterable[str]) -> list[str]:
    values: list[str] = []
    for value in (default, *configured):
        normalized = value.strip().lower()
        if normalized and normalized not in values:
            values.append(normalized)
    return values


def _require_known(value: str, known: frozenset[str], kind: str) -> None:
    if value not in known:
        raise PipelineSelectionError(f"Unknown {kind}: {value}")


def _require_enabled(value: str, enabled: list[str], kind: str) -> None:
    if value not in enabled:
        raise PipelineSelectionError(
            f"{kind.capitalize()} '{value}' is not enabled for this deployment"
        )


def parser_supports_layout(parser_provider: str, layout_profile: str) -> bool:
    plugin = PARSER_PLUGINS.get(parser_provider)
    # Unknown deployment defaults remain runtime parser errors so the job can
    # persist their failure; explicit user selections are rejected earlier.
    return plugin is None or plugin.supports_layout(layout_profile)


def _require_compatible_layout(parser_provider: str, layout_profile: str) -> None:
    if not parser_supports_layout(parser_provider, layout_profile):
        raise PipelineSelectionError(
            f"Layout profile '{layout_profile}' is not supported by parser provider "
            f"'{parser_provider}'"
        )


def _availability(
    settings: Settings,
    kind: str,
    value: str,
) -> str | None:
    if kind == "parser":
        plugin = PARSER_PLUGINS.get(value)
        return plugin.unavailable_reason(settings) if plugin is not None else None
    if (
        kind == "recommendation"
        and value == "external_solver"
        and not settings.external_provider_url
    ):
        return "External solver URL is not configured"
    if kind == "recommendation" and value == "llm_advice" and not settings.llm_advice_url:
        return "LLM advice URL is not configured"
    return None


def configured_local_solver_engine(settings: Settings) -> str:
    if (settings.local_solver_command or "").strip():
        return "custom_local"
    return settings.local_solver_engine.strip().lower()


def configured_recommendation_engine(settings: Settings) -> str | None:
    if settings.recommendation_provider.strip().lower() != "local_solver":
        return None
    return configured_local_solver_engine(settings)


def resolve_pipeline_selection(
    settings: Settings,
    *,
    parser_provider: str | None = None,
    parser_layout_profile: str | None = None,
    recommendation_provider: str | None = None,
    recommendation_engine: str | None = None,
    require_known_defaults: bool = False,
    validate_parser: bool = True,
    enforce_recommendation_allowlist: bool = True,
    validate_availability: bool = True,
    validate_layout_compatibility: bool = True,
) -> PipelineSelection:
    selected_parser = (parser_provider or settings.parser_provider).strip().lower()
    selected_layout = (
        parser_layout_profile or settings.parser_layout_profile
    ).strip().lower()
    selected_recommendation = (
        recommendation_provider or settings.recommendation_provider
    ).strip().lower()

    if validate_parser:
        if parser_provider is not None or require_known_defaults:
            _require_known(selected_parser, PARSER_PLUGIN_IDS, "parser provider")
    if recommendation_provider is not None or require_known_defaults:
        _require_known(
            selected_recommendation,
            KNOWN_RECOMMENDATION_PROVIDERS,
            "recommendation provider",
        )
    if validate_parser:
        _require_enabled(
            selected_parser,
            _enabled(settings.parser_provider, settings.parser_enabled_providers),
            "parser provider",
        )
        _require_enabled(
            selected_layout,
            _enabled(
                settings.parser_layout_profile,
                settings.parser_enabled_layout_profiles,
            ),
            "layout profile",
        )
        if validate_layout_compatibility:
            _require_compatible_layout(selected_parser, selected_layout)
    if enforce_recommendation_allowlist:
        _require_enabled(
            selected_recommendation,
            _enabled(
                settings.recommendation_provider,
                settings.recommendation_enabled_providers,
            ),
            "recommendation provider",
        )
    if validate_availability:
        if validate_parser:
            parser_unavailable = _availability(settings, "parser", selected_parser)
            if parser_unavailable:
                raise PipelineSelectionError(parser_unavailable)
        recommendation_unavailable = _availability(
            settings,
            "recommendation",
            selected_recommendation,
        )
        if recommendation_unavailable:
            raise PipelineSelectionError(recommendation_unavailable)

    selected_engine: str | None = None
    if selected_recommendation == "local_solver":
        configured_engine = configured_local_solver_engine(settings)
        selected_engine = (recommendation_engine or configured_engine).strip().lower()
        if configured_engine == "custom_local":
            if selected_engine != "custom_local":
                raise PipelineSelectionError(
                    "A custom local solver command is fixed for this deployment"
                )
        else:
            _require_known(
                selected_engine,
                KNOWN_LOCAL_SOLVER_ENGINES,
                "recommendation engine",
            )
            if enforce_recommendation_allowlist:
                _require_enabled(
                    selected_engine,
                    _enabled(
                        settings.local_solver_engine,
                        settings.local_solver_enabled_engines,
                    ),
                    "recommendation engine",
                )
    elif recommendation_engine:
        raise PipelineSelectionError(
            "A recommendation engine can be selected only with the local solver provider"
        )

    return PipelineSelection(
        parser_provider=selected_parser,
        parser_layout_profile=selected_layout,
        recommendation_provider=selected_recommendation,
        recommendation_engine=selected_engine,
    )


def settings_for_selection(
    settings: Settings,
    selection: PipelineSelection,
) -> Settings:
    updates: dict[str, object] = {
        "parser_provider": selection.parser_provider,
        "parser_layout_profile": selection.parser_layout_profile,
        "recommendation_provider": selection.recommendation_provider,
    }
    if (
        selection.recommendation_provider == "local_solver"
        and selection.recommendation_engine not in {None, "custom_local"}
    ):
        updates["local_solver_engine"] = selection.recommendation_engine
    return settings.model_copy(update=updates)


def _option(
    value: str,
    labels: dict[str, str],
    unavailable_reason: str | None = None,
) -> PipelineOption:
    return PipelineOption(
        id=value,
        label=labels.get(value, value.replace("_", " ").title()),
        available=unavailable_reason is None,
        unavailable_reason=unavailable_reason,
    )


def _parser_option(
    settings: Settings,
    value: str,
    compatible_layouts: list[str],
) -> PipelineOption:
    unavailable_reason = _availability(settings, "parser", value)
    if unavailable_reason is None and not compatible_layouts:
        unavailable_reason = "No enabled layout profile is compatible with this parser"
    return PipelineOption(
        id=value,
        label=get_parser_plugin(value).label,
        available=unavailable_reason is None,
        unavailable_reason=unavailable_reason,
    )


def pipeline_capabilities(settings: Settings) -> PipelineCapabilities:
    defaults = resolve_pipeline_selection(
        settings,
        require_known_defaults=True,
        validate_availability=False,
        validate_layout_compatibility=False,
    )
    parsers = _enabled(settings.parser_provider, settings.parser_enabled_providers)
    layouts = _enabled(
        settings.parser_layout_profile,
        settings.parser_enabled_layout_profiles,
    )
    recommendations = _enabled(
        settings.recommendation_provider,
        settings.recommendation_enabled_providers,
    )
    configured_engine = configured_local_solver_engine(settings)
    engines = (
        ["custom_local"]
        if configured_engine == "custom_local"
        else _enabled(settings.local_solver_engine, settings.local_solver_enabled_engines)
    )
    layout_compatibility = {
        parser: [
            layout
            for layout in layouts
            if parser_supports_layout(parser, layout)
        ]
        for parser in parsers
    }
    return PipelineCapabilities(
        defaults=defaults,
        parser_providers=[
            _parser_option(settings, value, layout_compatibility[value])
            for value in parsers
        ],
        parser_layout_profiles=[_option(value, LAYOUT_LABELS) for value in layouts],
        parser_layout_compatibility=layout_compatibility,
        recommendation_providers=[
            _option(
                value,
                RECOMMENDATION_LABELS,
                _availability(settings, "recommendation", value),
            )
            for value in recommendations
        ],
        recommendation_engines=[_option(value, ENGINE_LABELS) for value in engines],
    )
