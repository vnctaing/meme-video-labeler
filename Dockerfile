FROM ghcr.io/astral-sh/uv:0.12.24@sha256:3af4716e991d6956a41e573eab705d0ee08500cd829ed30293eb8472f372c65a AS uv

FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e

# opencv-python is the non-headless build, so it links libGL and glib.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

WORKDIR /app/pipeline
COPY pipeline/pyproject.toml pipeline/uv.lock ./
RUN uv sync --frozen --no-dev
COPY pipeline/labelmeme labelmeme
COPY web/site /app/site

ENV PATH="/app/pipeline/.venv/bin:$PATH" LABELMEME_SITE_DIR=/app/site
EXPOSE 8080
CMD ["python", "-m", "labelmeme", "serve", "--host", "0.0.0.0", "--port", "8080"]
