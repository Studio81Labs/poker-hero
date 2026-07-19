import json
from pathlib import Path
import shlex
import subprocess
import sys

from pydantic import ValidationError

from app.config import Settings
from app.models import RecommendationRequest, RecommendationResult
from app.providers.base import ProviderConfigurationError, ProviderError


class LocalSolverProvider:
    name = "local_solver"
    required_fields = ["hero_cards", "street", "pot_size", "current_bet", "effective_stack", "players_in_hand"]

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def recommend(self, request: RecommendationRequest) -> RecommendationResult:
        command, cwd = self._command()
        try:
            completed = subprocess.run(
                command,
                input=request.model_dump_json(),
                text=True,
                capture_output=True,
                cwd=cwd,
                timeout=self.settings.local_solver_timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("Local solver timed out") from exc
        except OSError as exc:
            raise ProviderError(f"Local solver could not be started: {exc}") from exc

        if completed.returncode != 0:
            output = completed.stderr.strip() or completed.stdout.strip() or "no output"
            raise ProviderError(f"Local solver failed with return code {completed.returncode}: {output}")

        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ProviderError("Local solver returned invalid JSON") from exc

        try:
            return RecommendationResult.model_validate(payload)
        except ValidationError as exc:
            raise ProviderError("Local solver returned invalid payload") from exc

    def _command(self) -> tuple[list[str], Path | None]:
        if self.settings.local_solver_command is None or self.settings.local_solver_command.strip() == "":
            return [sys.executable, "-m", "app.solvers.ev_solver_cli"], Path(__file__).resolve().parents[2]
        try:
            command = shlex.split(self.settings.local_solver_command or "")
        except ValueError as exc:
            raise ProviderConfigurationError("POKER_LOCAL_SOLVER_COMMAND is not a valid shell command") from exc
        if not command:
            raise ProviderConfigurationError("POKER_LOCAL_SOLVER_COMMAND is required for local_solver provider")
        return command, None
