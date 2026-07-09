from typing import Protocol

from app.models import CanonicalState, RecommendationRequest, RecommendationResult


class ProviderError(RuntimeError):
    pass


class ProviderConfigurationError(ProviderError):
    pass


class RecommendationProvider(Protocol):
    name: str
    required_fields: list[str]

    def recommend(self, request: RecommendationRequest) -> RecommendationResult:
        raise NotImplementedError


def field_has_value(state: CanonicalState, field_name: str) -> bool:
    value = getattr(state, field_name)
    if isinstance(value, list):
        return len(value) > 0
    return value is not None


def missing_required_fields(state: CanonicalState, required_fields: list[str]) -> list[str]:
    return [field_name for field_name in required_fields if not field_has_value(state, field_name)]
