from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
import shlex
import sys
from types import MappingProxyType
from typing import Literal, Mapping

from app.config import Settings
from app.providers.base import ProviderConfigurationError

SolverEngineMode = Literal["ev", "postflop", "custom"]


@dataclass(frozen=True)
class SolverCommand:
    engine_id: str
    arguments: tuple[str, ...]
    cwd: Path | None = None

    def __post_init__(self) -> None:
        if not self.engine_id or not self.arguments:
            raise ValueError("Solver command identity and arguments must not be empty")

    def subprocess_arguments(self) -> tuple[list[str], Path | None]:
        return list(self.arguments), self.cwd


SolverCommandFactory = Callable[[Settings], SolverCommand]


@dataclass(frozen=True)
class LocalSolverEnginePlugin:
    id: str
    label: str
    mode: SolverEngineMode
    command_factory: SolverCommandFactory
    deployment_selectable: bool = True

    def __post_init__(self) -> None:
        if not self.id or not self.label:
            raise ValueError("Local solver engine identity fields must not be empty")
        if self.mode not in {"ev", "postflop", "custom"}:
            raise ValueError(f"Unknown local solver engine mode: {self.mode}")
        if not callable(self.command_factory):
            raise TypeError("Local solver engine command factory must be callable")

    @property
    def uses_ev_routing(self) -> bool:
        return self.mode == "ev"

    @property
    def uses_postflop_routing(self) -> bool:
        return self.mode == "postflop"

    @property
    def is_custom(self) -> bool:
        return self.mode == "custom"

    def build_command(
        self,
        settings: Settings,
        *,
        extra_arguments: tuple[str, ...] = (),
    ) -> SolverCommand:
        command = self.command_factory(settings)
        if command.engine_id != self.id:
            raise ProviderConfigurationError(
                f"Local solver engine plugin '{self.id}' built command for "
                f"'{command.engine_id}'"
            )
        if not extra_arguments:
            return command
        return SolverCommand(
            engine_id=command.engine_id,
            arguments=(*command.arguments, *extra_arguments),
            cwd=command.cwd,
        )


def _parse_command(value: str | None, field_name: str) -> tuple[str, ...]:
    try:
        command = shlex.split(value or "")
    except ValueError as exc:
        raise ProviderConfigurationError(
            f"{field_name} is not a valid shell command"
        ) from exc
    if not command:
        raise ProviderConfigurationError(f"{field_name} must not be blank")
    return tuple(command)


def _build_local_ev_command(_settings: Settings) -> SolverCommand:
    return SolverCommand(
        engine_id="local_ev",
        arguments=(sys.executable, "-m", "app.solvers.ev_solver_cli"),
        cwd=Path(__file__).resolve().parents[2],
    )


def _build_postflop_solver_command(settings: Settings) -> SolverCommand:
    return SolverCommand(
        engine_id="postflop_solver",
        arguments=_parse_command(
            settings.postflop_solver_command,
            "POKER_POSTFLOP_SOLVER_COMMAND",
        ),
    )


def _build_custom_local_command(settings: Settings) -> SolverCommand:
    return SolverCommand(
        engine_id="custom_local",
        arguments=_parse_command(
            settings.local_solver_command,
            "POKER_LOCAL_SOLVER_COMMAND",
        ),
    )


def _plugin_catalog(
    *plugins: LocalSolverEnginePlugin,
) -> Mapping[str, LocalSolverEnginePlugin]:
    catalog = {plugin.id: plugin for plugin in plugins}
    if len(catalog) != len(plugins):
        raise ValueError("Local solver engine plugin IDs must be unique")
    return MappingProxyType(catalog)


LOCAL_SOLVER_ENGINE_PLUGINS = _plugin_catalog(
    LocalSolverEnginePlugin(
        id="local_ev",
        label="Local EV",
        mode="ev",
        command_factory=_build_local_ev_command,
    ),
    LocalSolverEnginePlugin(
        id="postflop_solver",
        label="Postflop CFR",
        mode="postflop",
        command_factory=_build_postflop_solver_command,
    ),
    LocalSolverEnginePlugin(
        id="custom_local",
        label="Custom local solver",
        mode="custom",
        command_factory=_build_custom_local_command,
        deployment_selectable=False,
    ),
)
LOCAL_SOLVER_ENGINE_PLUGIN_IDS = frozenset(LOCAL_SOLVER_ENGINE_PLUGINS)
DEPLOYMENT_SELECTABLE_LOCAL_SOLVER_ENGINE_IDS = frozenset(
    plugin.id
    for plugin in LOCAL_SOLVER_ENGINE_PLUGINS.values()
    if plugin.deployment_selectable
)


def get_local_solver_engine(engine_id: str) -> LocalSolverEnginePlugin:
    try:
        return LOCAL_SOLVER_ENGINE_PLUGINS[engine_id]
    except KeyError as exc:
        raise ProviderConfigurationError(
            f"Unknown local solver engine: {engine_id}"
        ) from exc


def resolve_configured_local_solver_engine(
    settings: Settings,
) -> LocalSolverEnginePlugin:
    if (settings.local_solver_command or "").strip():
        return get_local_solver_engine("custom_local")
    return get_local_solver_engine(settings.local_solver_engine.strip().lower())
