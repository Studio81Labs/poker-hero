"""Explicit runtime dependencies for HTTP transport adapters.

The application factory wires concrete settings, stores, and plugins into this
container. Routers receive only the use-case callables they need.
"""

from collections.abc import Callable
from dataclasses import dataclass

from app.models import HealthResponse, PipelineCapabilities


class PipelineCapabilitiesUnavailableError(Exception):
    """The configured pipeline cannot describe its available capabilities."""


@dataclass(frozen=True)
class ApiRuntime:
    """Read-only dependencies shared by the first extracted API routers."""

    get_health: Callable[[], HealthResponse]
    get_pipeline_capabilities: Callable[[], PipelineCapabilities]
