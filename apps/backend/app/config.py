from functools import lru_cache
from pathlib import Path
from typing import Annotated, Self
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Threshold = Annotated[float, Field(ge=0, le=1)]

DEFAULT_POSTFLOP_OOP_RANGE = "66+,A8s+,A5s-A4s,AJo+,K9s+,KQo,QTs+,JTs,96s+,85s+,75s+,65s,54s"
DEFAULT_POSTFLOP_IP_RANGE = (
    "QQ-22,AQs-A2s,ATo+,K5s+,KJo+,Q8s+,J8s+,T7s+,96s+,86s+,75s+,64s+,53s+"
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="POKER_",
        env_nested_delimiter="__",
        extra="ignore",
    )

    data_dir: Path = Field(default=Path("data"))
    parser_provider: str = Field(default="mock")
    parser_layout_profile: str = Field(default="generic")
    parser_auto_approve_enabled: bool = Field(default=False)
    parser_auto_approve_thresholds: dict[str, Threshold] = Field(
        default_factory=lambda: {
            "hero_cards": 0.98,
            "board_cards": 0.98,
            "pot_size": 0.95,
            "street": 0.99,
        }
    )
    recommendation_provider: str = Field(default="rule_based")
    external_parser_url: str | None = Field(default=None)
    external_parser_bearer_token: SecretStr | None = Field(default=None)
    external_provider_url: str | None = Field(default=None)
    external_provider_bearer_token: SecretStr | None = Field(default=None)
    llm_advice_url: str | None = Field(default=None)
    llm_advice_bearer_token: SecretStr | None = Field(default=None)
    external_request_timeout_seconds: float = Field(default=60.0, gt=0)
    local_solver_command: str | None = Field(default=None)
    local_solver_engine: str = Field(default="postflop_solver")
    local_solver_timeout_seconds: float = Field(default=120.0, gt=0)
    postflop_solver_command: str = Field(default="poker-postflop-solver")
    postflop_solver_fallback_enabled: bool = Field(default=True)
    postflop_solver_max_iterations: int = Field(default=400, gt=0)
    postflop_solver_target_exploitability: float = Field(default=0.01, gt=0, le=1)
    postflop_solver_max_memory_mb: int = Field(default=768, gt=0)
    postflop_solver_bet_sizes: str = Field(default="70%")
    postflop_solver_raise_sizes: str = Field(default="2.5x")
    postflop_solver_rake_rate: float = Field(default=0, ge=0, le=1)
    postflop_solver_rake_cap: float = Field(default=0, ge=0)
    postflop_solver_oop_range: str = Field(default=DEFAULT_POSTFLOP_OOP_RANGE)
    postflop_solver_ip_range: str = Field(default=DEFAULT_POSTFLOP_IP_RANGE)
    max_upload_bytes: int = Field(default=10 * 1024 * 1024, gt=0)
    max_dataset_upload_bytes: int = Field(default=100 * 1024 * 1024, gt=0)
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    proxy_shared_secret: SecretStr | None = Field(default=None)

    @field_validator(
        "external_parser_bearer_token",
        "external_provider_bearer_token",
        "llm_advice_bearer_token",
        "proxy_shared_secret",
        mode="before",
    )
    @classmethod
    def normalize_optional_secret(cls, value: object) -> object:
        if isinstance(value, str):
            normalized = value.strip()
            return normalized or None
        return value

    @field_validator(
        "external_parser_bearer_token",
        "external_provider_bearer_token",
        "llm_advice_bearer_token",
    )
    @classmethod
    def validate_bearer_token(
        cls,
        value: SecretStr | None,
    ) -> SecretStr | None:
        if value is None:
            return value
        token = value.get_secret_value()
        if not token.isascii():
            raise ValueError("bearer tokens must contain ASCII characters only")
        if any(
            character.isspace() or ord(character) < 32 or ord(character) == 127
            for character in token
        ):
            raise ValueError("bearer tokens must not contain whitespace or control characters")
        return value

    @field_validator("proxy_shared_secret")
    @classmethod
    def validate_proxy_shared_secret(
        cls,
        value: SecretStr | None,
    ) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < 32:
            raise ValueError("proxy_shared_secret must contain at least 32 characters")
        return value

    @model_validator(mode="after")
    def validate_authenticated_external_urls(self) -> Self:
        authenticated_urls = (
            (
                "POKER_EXTERNAL_PARSER_URL",
                self.external_parser_url,
                self.external_parser_bearer_token,
            ),
            (
                "POKER_EXTERNAL_PROVIDER_URL",
                self.external_provider_url,
                self.external_provider_bearer_token,
            ),
            (
                "POKER_LLM_ADVICE_URL",
                self.llm_advice_url,
                self.llm_advice_bearer_token,
            ),
        )
        for field_name, url, token in authenticated_urls:
            if token is not None and url is not None and urlsplit(url).scheme.lower() != "https":
                raise ValueError(f"{field_name} must use HTTPS when its bearer token is configured")
        return self


@lru_cache
def get_settings() -> Settings:
    # Keep direct Settings(...) construction deterministic for tests and tools;
    # only the application-level loader reads the working-directory .env file.
    return Settings(_env_file=".env")
