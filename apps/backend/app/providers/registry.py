from app.config import Settings
from app.providers.base import ProviderConfigurationError, RecommendationProvider
from app.providers.http_provider import HttpRecommendationProvider
from app.providers.local_solver import LocalSolverProvider
from app.providers.mock import MockRecommendationProvider
from app.providers.rule_based import RuleBasedTrainingProvider


def build_provider(settings: Settings) -> RecommendationProvider:
    if settings.recommendation_provider == "mock":
        return MockRecommendationProvider()
    if settings.recommendation_provider == "rule_based":
        return RuleBasedTrainingProvider()
    if settings.recommendation_provider == "local_solver":
        return LocalSolverProvider(settings)
    if settings.recommendation_provider == "external_solver":
        return HttpRecommendationProvider(
            name="external_solver",
            url=settings.external_provider_url,
            missing_message="POKER_EXTERNAL_PROVIDER_URL is required for external_solver provider",
        )
    if settings.recommendation_provider == "llm_advice":
        return HttpRecommendationProvider(
            name="llm_advice",
            url=settings.llm_advice_url,
            missing_message="POKER_LLM_ADVICE_URL is required for llm_advice provider",
        )
    raise ProviderConfigurationError(f"Unknown recommendation provider: {settings.recommendation_provider}")
