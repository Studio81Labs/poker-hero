# syntax=docker/dockerfile:1.25

# Build from the repository root:
# docker build -f apps/backend/Dockerfile .
FROM rust:1.85-slim-bookworm AS postflop-solver-builder

WORKDIR /build

COPY solver-plugins/postflop/Cargo.toml solver-plugins/postflop/Cargo.lock ./
COPY solver-plugins/postflop/src ./src

RUN cargo build --locked --release

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    POKER_DATA_DIR=/app/data

WORKDIR /app

RUN addgroup --system poker && adduser --system --ingroup poker poker \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

COPY apps/backend/pyproject.toml ./
COPY apps/backend/app ./app
COPY apps/backend/docker-entrypoint.sh /usr/local/bin/backend-entrypoint.sh
COPY --from=postflop-solver-builder /build/target/release/poker-postflop-solver /usr/local/bin/poker-postflop-solver

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir .

RUN chmod +x /usr/local/bin/backend-entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R poker:poker /app/data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"

ENTRYPOINT ["/usr/local/bin/backend-entrypoint.sh"]
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
