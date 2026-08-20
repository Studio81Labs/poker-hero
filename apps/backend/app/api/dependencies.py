"""Explicit runtime dependencies for HTTP transport adapters.

The application factory wires concrete settings, stores, and plugins into this
container. Routers receive only the use-case callables they need.
"""

from collections.abc import Callable
from dataclasses import dataclass

from app.models import ArchiveJobsRequest, HealthResponse, JobHistory, PipelineCapabilities


class PipelineCapabilitiesUnavailableError(Exception):
    """The configured pipeline cannot describe its available capabilities."""


@dataclass(frozen=True)
class ApiRuntime:
    """Read-only dependencies shared by the first extracted API routers."""

    get_health: Callable[[], HealthResponse]
    get_pipeline_capabilities: Callable[[], PipelineCapabilities]


@dataclass(frozen=True)
class HistoryRuntime:
    """Dependencies required by the history transport endpoints."""

    list_history: Callable[[int, int, str | None], JobHistory]
    archive_jobs: Callable[[ArchiveJobsRequest, int], JobHistory]
