import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from typing import Literal

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
        command, cwd, fallback_reason = self._command(request)
        try:
            result = self._run(command, cwd, request)
        except ProviderError as exc:
            if not self._can_fallback():
                raise
            fallback_reason = str(exc)
            fallback_command, fallback_cwd = self._ev_command()
            result = self._run(fallback_command, fallback_cwd, request)

        if fallback_reason is not None:
            result.raw["requested_engine"] = "postflop_solver"
            result.raw["fallback_reason"] = fallback_reason
            result.explanation = (
                f"The postflop solver used the range/EV fallback because {fallback_reason}. "
                f"{result.explanation}"
            )
        return result

    def _run(
        self,
        command: list[str],
        cwd: Path | None,
        request: RecommendationRequest,
    ) -> RecommendationResult:
        try:
            completed = subprocess.run(
                command,
                input=request.model_dump_json(),
                text=True,
                capture_output=True,
                cwd=cwd,
                env=self._environment(),
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

    def _command(
        self, request: RecommendationRequest
    ) -> tuple[list[str], Path | None, str | None]:
        if self.settings.local_solver_command is not None and self.settings.local_solver_command.strip() != "":
            return (
                self._parse_command(self.settings.local_solver_command, "POKER_LOCAL_SOLVER_COMMAND"),
                None,
                None,
            )

        engine = self.settings.local_solver_engine.strip().lower()
        if engine == "local_ev":
            command, cwd = self._ev_command()
            return command, cwd, None
        if engine != "postflop_solver":
            raise ProviderConfigurationError(f"Unknown local solver engine: {self.settings.local_solver_engine}")

        unsupported_reason = self._postflop_unsupported_reason(request)
        if unsupported_reason is not None:
            if not self.settings.postflop_solver_fallback_enabled:
                raise ProviderConfigurationError(unsupported_reason)
            command, cwd = self._ev_command()
            return command, cwd, unsupported_reason

        command = self._parse_command(
            self.settings.postflop_solver_command,
            "POKER_POSTFLOP_SOLVER_COMMAND",
        )
        return command, None, None

    def _can_fallback(self) -> bool:
        custom_command_missing = (
            self.settings.local_solver_command is None
            or self.settings.local_solver_command.strip() == ""
        )
        return (
            custom_command_missing
            and self.settings.local_solver_engine.strip().lower() == "postflop_solver"
            and self.settings.postflop_solver_fallback_enabled
        )

    @staticmethod
    def _postflop_unsupported_reason(request: RecommendationRequest) -> str | None:
        state = request.state
        expected_board_cards = {"flop": 3, "turn": 4, "river": 5}
        if state.street == "preflop":
            return "the hand is preflop"
        if state.street not in expected_board_cards:
            return "the postflop street is missing"
        if len(state.hero_cards) != 2:
            return "exactly two hero cards are required"
        if len(state.board_cards) != expected_board_cards[state.street]:
            return f"the {state.street} requires {expected_board_cards[state.street]} board cards"
        if state.players_in_hand != 2:
            return "the open-source engine supports heads-up postflop spots only"
        if _postflop_position(state.hero_position) is None:
            return "hero position must identify IP or OOP"
        if (state.current_bet or 0) > 0 and state.facing_action != "bet":
            return "facing action must identify a single bet; raises require full action history"
        if (state.current_bet or 0) > 0 and (state.hero_stack is None or state.hero_stack <= 0):
            return "hero stack is required to reconstruct a facing-bet postflop tree"
        return None

    @staticmethod
    def _ev_command() -> tuple[list[str], Path]:
        return [sys.executable, "-m", "app.solvers.ev_solver_cli"], Path(__file__).resolve().parents[2]

    @staticmethod
    def _parse_command(value: str, field_name: str) -> list[str]:
        try:
            command = shlex.split(value)
        except ValueError as exc:
            raise ProviderConfigurationError(f"{field_name} is not a valid shell command") from exc
        if not command:
            raise ProviderConfigurationError(f"{field_name} must not be blank")
        return command

    def _environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "POKER_POSTFLOP_SOLVER_MAX_ITERATIONS": str(
                    self.settings.postflop_solver_max_iterations
                ),
                "POKER_POSTFLOP_SOLVER_TARGET_EXPLOITABILITY": str(
                    self.settings.postflop_solver_target_exploitability
                ),
                "POKER_POSTFLOP_SOLVER_MAX_MEMORY_MB": str(
                    self.settings.postflop_solver_max_memory_mb
                ),
                "POKER_POSTFLOP_SOLVER_BET_SIZES": self.settings.postflop_solver_bet_sizes,
                "POKER_POSTFLOP_SOLVER_RAISE_SIZES": self.settings.postflop_solver_raise_sizes,
                "POKER_POSTFLOP_SOLVER_RAKE_RATE": str(self.settings.postflop_solver_rake_rate),
                "POKER_POSTFLOP_SOLVER_RAKE_CAP": str(self.settings.postflop_solver_rake_cap),
                "POKER_POSTFLOP_SOLVER_OOP_RANGE": self.settings.postflop_solver_oop_range,
                "POKER_POSTFLOP_SOLVER_IP_RANGE": self.settings.postflop_solver_ip_range,
            }
        )
        return environment


def _postflop_position(value: str | None) -> Literal["ip", "oop"] | None:
    if value is None:
        return None
    normalized = " ".join(value.lower().replace("_", " ").replace("-", " ").split())
    if normalized in {"ip", "in position", "button", "btn"}:
        return "ip"
    if normalized in {"oop", "out of position"}:
        return "oop"
    return None
