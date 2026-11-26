FROM node:22-slim

# No claude/codex/agy installed — fresh environment
WORKDIR /app

# Copy packed tarball and e2e scripts (passed in via docker build context)
COPY . /app/

# Make stubs executable
RUN chmod +x /app/test/e2e/stubs/claude \
              /app/test/e2e/stubs/codex \
              /app/test/e2e/stubs/agy \
              /app/test/e2e/stubs/openclaw \
              /app/test/e2e/run.sh

ENV REPO_ROOT=/app

CMD ["bash", "/app/test/e2e/run.sh"]
