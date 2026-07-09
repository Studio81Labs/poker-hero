from pathlib import Path

import httpx

from app.config import Settings
from app.models import ParserResult
from app.parsers.base import ParserConfigurationError, ParserError


class HttpVisionParser:
    name = "llm_vision"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def parse(self, image_path: Path) -> ParserResult:
        if not self.settings.external_parser_url:
            raise ParserConfigurationError("POKER_EXTERNAL_PARSER_URL is required for llm_vision parser")
        if not image_path.exists():
            raise ParserError(f"Screenshot file does not exist: {image_path}")

        with image_path.open("rb") as image_file:
            response = httpx.post(
                self.settings.external_parser_url,
                files={"image": (image_path.name, image_file, "application/octet-stream")},
                data={"layout_profile": self.settings.parser_layout_profile},
                timeout=60.0,
            )

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise ParserError(f"Vision parser request failed with status {exc.response.status_code}") from exc

        return ParserResult.model_validate(response.json())
