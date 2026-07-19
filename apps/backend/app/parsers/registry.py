from app.config import Settings
from app.parsers.base import ParserConfigurationError, ScreenshotParser
from app.parsers.http_vision import HttpVisionParser
from app.parsers.mock import MockParser
from app.parsers.ocr_cv import OcrCvParser


def build_parser(settings: Settings) -> ScreenshotParser:
    if settings.parser_provider == "mock":
        return MockParser()
    if settings.parser_provider == "llm_vision":
        return HttpVisionParser(settings)
    if settings.parser_provider == "ocr_cv":
        return OcrCvParser(settings.parser_layout_profile)
    raise ParserConfigurationError(f"Unknown parser provider: {settings.parser_provider}")
