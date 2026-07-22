from json import JSONDecodeError

import httpx
from pydantic import ValidationError

from app.models import CanonicalState, RecommendationRequest, RecommendationResult
from app.providers.base import ProviderConfigurationError, ProviderError


class HttpRecommendationProvider:
    required_fields = ["hero_cards", "street", "pot_size"]

    def __init__(self, name: str, url: str | None, missing_message: str) -> None:
        self.name = name
        self.url = url
        self.missing_message = missing_message

    def required_fields_for(self, state: CanonicalState) -> list[str]:
        return self.required_fields

    def recommend(self, request: RecommendationRequest) -> RecommendationResult:
        if not self.url:
            raise ProviderConfigurationError(self.missing_message)

        payload = request.model_dump(mode="json")
        state_payload = payload["state"]
        for field in ("preflop_opener_position", "preflop_open_size"):
            if state_payload[field] is None:
                del state_payload[field]

        try:
            response = httpx.post(
                self.url,
                json=payload,
                timeout=60.0,
            )
        except httpx.RequestError as exc:
            raise ProviderError(f"{self.name} request failed for {self.url}: {exc}") from exc

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise ProviderError(f"{self.name} request failed with status {exc.response.status_code}") from exc

        try:
            payload = response.json()
        except JSONDecodeError as exc:
            raise ProviderError(f"{self.name} returned invalid JSON") from exc

        try:
            return RecommendationResult.model_validate(payload)
        except ValidationError as exc:
            raise ProviderError(f"{self.name} returned invalid payload") from exc
