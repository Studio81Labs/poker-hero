import json
import shlex
import subprocess

from pydantic import ValidationError

from app.config import Settings
from app.models import RecommendationRequest, RecommendationResult
from app.providers.base import ProviderConfigurationError, ProviderError


class LocalSolverProvider:
    name = "local_solver"
    required_fields = ["hero_cards", "street", "pot_size", "effective_stack"]

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def recommend(self, request: RecommendationRequest) -> RecommendationResult:
        if not self.settings.local_solver_command:
            raise ProviderConfigurationError("POKER_LOCAL_SOLVER_COMMAND is required for local_solver provider")

        try:
            command = shlex.split(self.settings.local_solver_command)
        except ValueError as exc:
            raise ProviderConfigurationError("POKER_LOCAL_SOLVER_COMMAND is not a valid shell command") from exc

        try:
            completed = subprocess.run(
                command,
                input=request.model_dump_json(),
                text=True,
                capture_output=True,
                timeout=self.settings.local_solver_timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("Local solver timed out") from exc
        except OSError as exc:
            raise ProviderError(f"Local solver could not be started: {exc}") from exc

        if completed.returncode != 0:
            raise ProviderError(f"Local solver failed: {completed.stderr.strip()}")

        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ProviderError("Local solver returned invalid JSON") from exc

        try:
            return RecommendationResult.model_validate(payload)
        except ValidationError as exc:
            raise ProviderError("Local solver returned invalid payload") from exc
