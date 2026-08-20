"""Explicit runtime dependencies for HTTP transport adapters.

The application factory wires concrete settings, stores, and plugins into this
container. Routers receive only the use-case callables they need.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app.mcp_access import (
    CreateMcpPrincipalRequest,
    McpAccessConfig,
    McpIssuedPrincipal,
    McpPrincipalList,
    McpPrincipalSummary,
)
from app.models import (
    ArchiveJobsRequest,
    HealthResponse,
    JobHistory,
    JobQueue,
    JobRecord,
    PipelineCapabilities,
    RecommendationAction,
    Street,
    TrainingProgress,
    TrainingReviewCertainty,
    TrainingReviewOrder,
    TrainingReviewRequest,
)


class PipelineCapabilitiesUnavailableError(Exception):
    """The configured pipeline cannot describe its available capabilities."""


class JobReadNotFoundError(Exception):
    """A requested job record or image is not available."""


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


@dataclass(frozen=True)
class JobImage:
    """An image payload prepared by the job-read application boundary."""

    content: bytes
    media_type: str


@dataclass(frozen=True)
class JobsReadRuntime:
    """Dependencies required by read-only processing job endpoints."""

    list_jobs: Callable[[int, int], JobQueue]
    get_job: Callable[[str], JobRecord]
    get_image: Callable[[str], JobImage]


@dataclass(frozen=True)
class McpAdminRuntime:
    """Dependencies required by the MCP administration transport endpoints."""

    get_config: Callable[[], McpAccessConfig]
    list_principals: Callable[[], Awaitable[McpPrincipalList]]
    create_principal: Callable[
        [CreateMcpPrincipalRequest],
        Awaitable[McpIssuedPrincipal],
    ]
    rotate_principal: Callable[[str], Awaitable[McpIssuedPrincipal]]
    revoke_principal: Callable[[str], Awaitable[McpPrincipalSummary]]


@dataclass(frozen=True)
class TrainingProgressQuery:
    """Validated filters passed from HTTP transport to training aggregation."""

    review_order: TrainingReviewOrder
    review_street: Street | None
    review_certainty: TrainingReviewCertainty | None
    review_position: str | None
    review_unpositioned: bool
    review_action_difference: (
        tuple[RecommendationAction, RecommendationAction] | None
    )
    lesson_order: TrainingReviewOrder
    lesson_street: Street | None
    lesson_query: str | None
    solver_fallback_key: str | None
    solver_route_key: str | None
    solver_unattributed: bool
    recent_street: Street | None
    recent_position: str | None
    recent_unpositioned: bool
    recent_certainty: TrainingReviewCertainty | None


@dataclass(frozen=True)
class TrainingRuntime:
    """Dependencies required by the training transport endpoints."""

    complete_review: Callable[[str, TrainingReviewRequest | None], JobRecord]
    reopen_review: Callable[[str], JobRecord]
    get_progress: Callable[[TrainingProgressQuery], TrainingProgress]
    export_lessons: Callable[
        [TrainingReviewOrder, Street | None, str | None],
        tuple[str, str],
    ]
