from pathlib import Path

from app.models import ParserResult
from app.parsers.base import ParserConfigurationError


class OcrCvParser:
    name = "ocr_cv"

    def parse(self, image_path: Path) -> ParserResult:
        raise ParserConfigurationError(
            "OCR/CV parser requires a concrete OCR command or library adapter before it can parse screenshots"
        )
