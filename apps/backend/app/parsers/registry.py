from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

from app.config import Settings
from app.ocr_layouts import OCR_CV_LAYOUT_PROFILE_IDS
from app.parsers.base import ParserConfigurationError, ScreenshotParser
from app.parsers.http_vision import HttpVisionParser
from app.parsers.mock import MockParser
from app.parsers.ocr_cv import OcrCvParser

ParserFactory = Callable[[Settings], ScreenshotParser]
ParserAvailabilityCheck = Callable[[Settings], str | None]


@dataclass(frozen=True)
class ParserPlugin:
    id: str
    label: str
    factory: ParserFactory
    supported_layouts: frozenset[str] | None = None
    availability_check: ParserAvailabilityCheck | None = None

    def __post_init__(self) -> None:
        if not self.id or not self.label:
            raise ValueError("Parser plugin identity fields must not be empty")
        if not callable(self.factory):
            raise TypeError("Parser plugin factory must be callable")
        if self.availability_check is not None and not callable(self.availability_check):
            raise TypeError("Parser plugin availability check must be callable")
        if self.supported_layouts is not None and not self.supported_layouts:
            raise ValueError("Parser plugin supported layouts must not be empty")

    def build(self, settings: Settings) -> ScreenshotParser:
        parser = self.factory(settings)
        if parser.name != self.id:
            raise ParserConfigurationError(
                f"Parser plugin '{self.id}' built parser '{parser.name}'"
            )
        return parser

    def supports_layout(self, layout_profile: str) -> bool:
        return self.supported_layouts is None or layout_profile in self.supported_layouts

    def unavailable_reason(self, settings: Settings) -> str | None:
        if self.availability_check is None:
            return None
        return self.availability_check(settings)


def _build_mock(_settings: Settings) -> ScreenshotParser:
    return MockParser()


def _build_http_vision(settings: Settings) -> ScreenshotParser:
    return HttpVisionParser(settings)


def _build_ocr_cv(settings: Settings) -> ScreenshotParser:
    return OcrCvParser(settings.parser_layout_profile)


def _external_vision_availability(settings: Settings) -> str | None:
    if not settings.external_parser_url:
        return "External parser URL is not configured"
    return None


def _plugin_catalog(*plugins: ParserPlugin) -> Mapping[str, ParserPlugin]:
    catalog = {plugin.id: plugin for plugin in plugins}
    if len(catalog) != len(plugins):
        raise ValueError("Parser plugin IDs must be unique")
    return MappingProxyType(catalog)


PARSER_PLUGINS = _plugin_catalog(
    ParserPlugin(
        id="mock",
        label="Mock parser",
        factory=_build_mock,
    ),
    ParserPlugin(
        id="llm_vision",
        label="External vision",
        factory=_build_http_vision,
        availability_check=_external_vision_availability,
    ),
    ParserPlugin(
        id="ocr_cv",
        label="Template OCR",
        factory=_build_ocr_cv,
        supported_layouts=OCR_CV_LAYOUT_PROFILE_IDS,
    ),
)
PARSER_PLUGIN_IDS = frozenset(PARSER_PLUGINS)


def get_parser_plugin(provider_id: str) -> ParserPlugin:
    try:
        return PARSER_PLUGINS[provider_id]
    except KeyError as exc:
        raise ParserConfigurationError(f"Unknown parser provider: {provider_id}") from exc


def build_parser(settings: Settings) -> ScreenshotParser:
    return get_parser_plugin(settings.parser_provider).build(settings)
