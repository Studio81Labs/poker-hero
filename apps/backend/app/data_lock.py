import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path


DATA_LOCK_FILENAME = ".poker-hero-data.lock"


class DataLockError(RuntimeError):
    pass


class InterprocessDataLock:
    def __init__(self, data_dir: Path) -> None:
        self.lock_path = data_dir / DATA_LOCK_FILENAME

    def acquire(self, *, exclusive: bool) -> int:
        try:
            self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise DataLockError(
                f"Could not create data directory: {self.lock_path.parent}"
            ) from exc
        try:
            descriptor = os.open(
                self.lock_path,
                os.O_RDONLY | os.O_CREAT,
                0o644,
            )
        except OSError as exc:
            raise DataLockError(
                f"Could not open data lock in {self.lock_path.parent}"
            ) from exc
        operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        try:
            fcntl.flock(descriptor, operation)
        except OSError as exc:
            os.close(descriptor)
            raise DataLockError(
                f"Could not acquire data lock in {self.lock_path.parent}"
            ) from exc
        return descriptor

    async def acquire_async(self, *, exclusive: bool) -> int:
        acquisition = asyncio.create_task(
            asyncio.to_thread(self.acquire, exclusive=exclusive)
        )
        try:
            return await asyncio.shield(acquisition)
        except asyncio.CancelledError:
            # Shield keeps the blocking flock alive. If it later succeeds,
            # release its otherwise-unobserved descriptor immediately.
            acquisition.add_done_callback(self._release_cancelled_acquisition)
            raise

    def _release_cancelled_acquisition(self, acquisition: asyncio.Task[int]) -> None:
        try:
            descriptor = acquisition.result()
        except asyncio.CancelledError:
            return
        except Exception:
            return
        try:
            self.release(descriptor)
        except OSError:
            # release() closes the descriptor even if explicit unlock fails.
            pass

    @staticmethod
    def release(descriptor: int) -> None:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)

    @contextmanager
    def hold(self, *, exclusive: bool) -> Iterator[None]:
        descriptor = self.acquire(exclusive=exclusive)
        try:
            yield
        finally:
            self.release(descriptor)
