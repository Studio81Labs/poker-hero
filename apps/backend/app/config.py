from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

Threshold = Annotated[float, Field(ge=0, le=1)]


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
    external_provider_url: str | None = Field(default=None)
    llm_advice_url: str | None = Field(default=None)
    local_solver_command: str | None = Field(default=None)
    local_solver_engine: str = Field(default="postflop_solver")
    local_solver_timeout_seconds: float = Field(default=120.0, gt=0)
    postflop_solver_command: str = Field(default="poker-postflop-solver")
    postflop_solver_fallback_enabled: bool = Field(default=True)
    max_upload_bytes: int = Field(default=10 * 1024 * 1024, gt=0)
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])


@lru_cache
def get_settings() -> Settings:
    # Keep direct Settings(...) construction deterministic for tests and tools;
    # only the application-level loader reads the working-directory .env file.
    return Settings(_env_file=".env")
