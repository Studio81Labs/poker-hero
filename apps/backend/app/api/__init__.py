"""Public HTTP API compatibility facade.

The application factory remains available from :mod:`app.api` while the
composition root lives in :mod:`app.bootstrap`.  Keeping this package
initializer import-free lets individual routers be imported without starting
the legacy application bootstrap.
"""

from importlib import import_module
from typing import Any


def __getattr__(name: str) -> Any:
    """Lazily expose legacy public bootstrap symbols for compatibility."""

    bootstrap = import_module("app.bootstrap")
    try:
        return getattr(bootstrap, name)
    except AttributeError as exc:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from exc


def __dir__() -> list[str]:
    bootstrap = import_module("app.bootstrap")
    return sorted({*globals(), *dir(bootstrap)})
