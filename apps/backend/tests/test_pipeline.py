from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.pipeline import (
    PipelineSelectionError,
    pipeline_capabilities,
    resolve_pipeline_selection,
    settings_for_selection,
)


def test_capabilities_expose_defaults_and_enabled_plugins(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        parser_provider="ocr_cv",
        parser_layout_profile="fortuna_nations",
        parser_enabled_providers=["llm_vision"],
        parser_enabled_layout_profiles=["generic"],
        recommendation_provider="local_solver",
        recommendation_enabled_providers=["external_solver"],
        local_solver_engine="postflop_solver",
        local_solver_enabled_engines=["local_ev"],
    )

    capabilities = pipeline_capabilities(settings)

    assert capabilities.defaults.model_dump() == {
        "parser_provider": "ocr_cv",
        "parser_layout_profile": "fortuna_nations",
        "recommendation_provider": "local_solver",
        "recommendation_engine": "postflop_solver",
    }
    assert [option.id for option in capabilities.parser_providers] == [
        "ocr_cv",
        "llm_vision",
    ]
    assert capabilities.parser_providers[1].available is False
    assert capabilities.parser_providers[1].unavailable_reason == (
        "External parser URL is not configured"
    )
    assert [option.id for option in capabilities.parser_layout_profiles] == [
        "fortuna_nations",
        "generic",
    ]
    assert capabilities.parser_layout_compatibility == {
        "ocr_cv": ["fortuna_nations", "generic"],
        "llm_vision": ["fortuna_nations", "generic"],
    }
    assert [option.id for option in capabilities.recommendation_engines] == [
        "postflop_solver",
        "local_ev",
    ]
    assert capabilities.recommendation_providers[1].available is False


def test_capabilities_expose_fallbacks_when_defaults_are_unavailable(
    tmp_path: Path,
) -> None:
    settings = Settings(
        data_dir=tmp_path,
        parser_provider="llm_vision",
        parser_enabled_providers=["mock"],
        recommendation_provider="external_solver",
        recommendation_enabled_providers=["rule_based"],
    )

    capabilities = pipeline_capabilities(settings)

    assert capabilities.defaults.parser_provider == "llm_vision"
    assert capabilities.defaults.recommendation_provider == "external_solver"
    assert [option.model_dump() for option in capabilities.parser_providers] == [
        {
            "id": "llm_vision",
            "label": "External vision",
            "available": False,
            "unavailable_reason": "External parser URL is not configured",
        },
        {
            "id": "mock",
            "label": "Mock parser",
            "available": True,
            "unavailable_reason": None,
        },
    ]
    assert [
        option.model_dump() for option in capabilities.recommendation_providers
    ] == [
        {
            "id": "external_solver",
            "label": "External solver",
            "available": False,
            "unavailable_reason": "External solver URL is not configured",
        },
        {
            "id": "rule_based",
            "label": "Rule-based training",
            "available": True,
            "unavailable_reason": None,
        },
    ]

    with pytest.raises(PipelineSelectionError, match="URL is not configured"):
        resolve_pipeline_selection(settings)


def test_custom_layout_profiles_are_provider_aware(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        parser_provider="llm_vision",
        parser_enabled_providers=["ocr_cv"],
        parser_layout_profile="pokerstars",
        parser_enabled_layout_profiles=["fortuna_nations"],
        external_parser_url="https://parser.example.com/analyze",
    )

    capabilities = pipeline_capabilities(settings)

    assert [option.id for option in capabilities.parser_layout_profiles] == [
        "pokerstars",
        "fortuna_nations",
    ]
    assert capabilities.parser_layout_profiles[0].label == "PokerStars"
    assert capabilities.parser_layout_compatibility == {
        "llm_vision": ["pokerstars", "fortuna_nations"],
        "ocr_cv": ["fortuna_nations"],
    }
    assert resolve_pipeline_selection(
        settings,
        parser_provider="llm_vision",
        parser_layout_profile="pokerstars",
    ).parser_layout_profile == "pokerstars"

    with pytest.raises(PipelineSelectionError, match="not supported"):
        resolve_pipeline_selection(
            settings,
            parser_provider="ocr_cv",
            parser_layout_profile="pokerstars",
        )


def test_selection_rejects_plugins_not_enabled_for_deployment(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)

    with pytest.raises(PipelineSelectionError, match="not enabled"):
        resolve_pipeline_selection(settings, parser_provider="ocr_cv")

    with pytest.raises(PipelineSelectionError, match="Unknown parser provider"):
        resolve_pipeline_selection(settings, parser_provider="missing")


def test_selection_rejects_engine_without_local_solver(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)

    with pytest.raises(PipelineSelectionError, match="only with the local solver"):
        resolve_pipeline_selection(settings, recommendation_engine="local_ev")


def test_selection_builds_job_scoped_settings_copy(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        parser_provider="mock",
        parser_enabled_providers=["ocr_cv"],
        parser_layout_profile="generic",
        parser_enabled_layout_profiles=["fortuna"],
        recommendation_provider="rule_based",
        recommendation_enabled_providers=["local_solver"],
        local_solver_engine="postflop_solver",
        local_solver_enabled_engines=["local_ev"],
    )
    selection = resolve_pipeline_selection(
        settings,
        parser_provider="ocr_cv",
        parser_layout_profile="fortuna",
        recommendation_provider="local_solver",
        recommendation_engine="local_ev",
    )

    scoped = settings_for_selection(settings, selection)

    assert scoped.parser_provider == "ocr_cv"
    assert scoped.parser_layout_profile == "fortuna"
    assert scoped.recommendation_provider == "local_solver"
    assert scoped.local_solver_engine == "local_ev"
    assert settings.parser_provider == "mock"
    assert settings.local_solver_engine == "postflop_solver"


def test_persisted_recommendation_selection_can_outlive_allowlist_changes(
    tmp_path: Path,
) -> None:
    settings = Settings(
        data_dir=tmp_path,
        recommendation_provider="mock",
        recommendation_enabled_providers=["local_solver"],
        local_solver_engine="postflop_solver",
        local_solver_enabled_engines=["local_ev"],
    )
    selection = resolve_pipeline_selection(
        settings,
        recommendation_provider="local_solver",
        recommendation_engine="local_ev",
    )
    settings.recommendation_enabled_providers = []
    settings.local_solver_enabled_engines = []

    with pytest.raises(PipelineSelectionError, match="not enabled"):
        resolve_pipeline_selection(
            settings,
            recommendation_provider=selection.recommendation_provider,
            recommendation_engine=selection.recommendation_engine,
        )

    persisted = resolve_pipeline_selection(
        settings,
        recommendation_provider=selection.recommendation_provider,
        recommendation_engine=selection.recommendation_engine,
        enforce_recommendation_allowlist=False,
    )

    assert persisted == selection


def test_enabled_plugin_ids_are_normalized_and_validated(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        parser_enabled_providers=[" OCR_CV ", "ocr_cv"],
        parser_enabled_layout_profiles=[" PokerStars ", "pokerstars"],
    )

    assert settings.parser_enabled_providers == ["ocr_cv"]
    assert settings.parser_enabled_layout_profiles == ["pokerstars"]

    with pytest.raises(ValidationError, match="unknown plugin ID"):
        Settings(data_dir=tmp_path, parser_enabled_providers=["shell_command"])

    with pytest.raises(ValidationError, match="invalid layout profile ID"):
        Settings(data_dir=tmp_path, parser_enabled_layout_profiles=["poker-stars"])
