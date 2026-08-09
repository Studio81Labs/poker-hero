from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

from app.config import Settings
from app.providers.base import ProviderConfigurationError, RecommendationProvider
from app.providers.http_provider import HttpRecommendationProvider
from app.providers.local_solver import LocalSolverProvider
from app.providers.mock import MockRecommendationProvider
from app.providers.rule_based import RuleBasedTrainingProvider

ProviderFactory = Callable[[Settings], RecommendationProvider]
ProviderAvailabilityCheck = Callable[[Settings], str | None]


@dataclass(frozen=True)
class RecommendationPlugin:
    id: str
    label: str
    factory: ProviderFactory
    availability_check: ProviderAvailabilityCheck | None = None

    def __post_init__(self) -> None:
        if not self.id or not self.label:
            raise ValueError("Recommendation plugin identity fields must not be empty")
        if not callable(self.factory):
            raise TypeError("Recommendation plugin factory must be callable")
        if self.availability_check is not None and not callable(self.availability_check):
            raise TypeError("Recommendation plugin availability check must be callable")

    def build(self, settings: Settings) -> RecommendationProvider:
        provider = self.factory(settings)
        if provider.name != self.id:
            raise ProviderConfigurationError(
                f"Recommendation plugin '{self.id}' built provider '{provider.name}'"
            )
        return provider

    def unavailable_reason(self, settings: Settings) -> str | None:
        if self.availability_check is None:
            return None
        return self.availability_check(settings)


def _build_mock(_settings: Settings) -> RecommendationProvider:
    return MockRecommendationProvider()


def _build_rule_based(_settings: Settings) -> RecommendationProvider:
    return RuleBasedTrainingProvider()


def _build_local_solver(settings: Settings) -> RecommendationProvider:
    return LocalSolverProvider(settings)


def _build_external_solver(settings: Settings) -> RecommendationProvider:
    return HttpRecommendationProvider(
        name="external_solver",
        url=settings.external_provider_url,
        missing_message="POKER_EXTERNAL_PROVIDER_URL is required for external_solver provider",
        bearer_token=settings.external_provider_bearer_token,
        timeout_seconds=settings.external_request_timeout_seconds,
    )


def _build_llm_advice(settings: Settings) -> RecommendationProvider:
    return HttpRecommendationProvider(
        name="llm_advice",
        url=settings.llm_advice_url,
        missing_message="POKER_LLM_ADVICE_URL is required for llm_advice provider",
        bearer_token=settings.llm_advice_bearer_token,
        timeout_seconds=settings.external_request_timeout_seconds,
    )


def _external_solver_availability(settings: Settings) -> str | None:
    if not settings.external_provider_url:
        return "External solver URL is not configured"
    return None


def _llm_advice_availability(settings: Settings) -> str | None:
    if not settings.llm_advice_url:
        return "LLM advice URL is not configured"
    return None


def _plugin_catalog(
    *plugins: RecommendationPlugin,
) -> Mapping[str, RecommendationPlugin]:
    catalog = {plugin.id: plugin for plugin in plugins}
    if len(catalog) != len(plugins):
        raise ValueError("Recommendation plugin IDs must be unique")
    return MappingProxyType(catalog)


RECOMMENDATION_PLUGINS = _plugin_catalog(
    RecommendationPlugin(
        id="rule_based",
        label="Rule-based training",
        factory=_build_rule_based,
    ),
    RecommendationPlugin(
        id="mock",
        label="Mock recommendation",
        factory=_build_mock,
    ),
    RecommendationPlugin(
        id="local_solver",
        label="Local solver",
        factory=_build_local_solver,
    ),
    RecommendationPlugin(
        id="external_solver",
        label="External solver",
        factory=_build_external_solver,
        availability_check=_external_solver_availability,
    ),
    RecommendationPlugin(
        id="llm_advice",
        label="LLM advice",
        factory=_build_llm_advice,
        availability_check=_llm_advice_availability,
    ),
)
RECOMMENDATION_PLUGIN_IDS = frozenset(RECOMMENDATION_PLUGINS)


def get_recommendation_plugin(provider_id: str) -> RecommendationPlugin:
    try:
        return RECOMMENDATION_PLUGINS[provider_id]
    except KeyError as exc:
        raise ProviderConfigurationError(
            f"Unknown recommendation provider: {provider_id}"
        ) from exc


def build_provider(settings: Settings) -> RecommendationProvider:
    return get_recommendation_plugin(settings.recommendation_provider).build(settings)
