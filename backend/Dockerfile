# Use Python 3.11 slim image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install uv
RUN pip install uv

# Copy dependency files
COPY pyproject.toml uv.lock ./

# Install dependencies using uv
RUN uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY main.py ./

# Expose port (Cloud Run will set PORT env var)
ENV PORT=8080
EXPOSE 8080

# Run the application
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT}
