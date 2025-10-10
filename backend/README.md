# ReadAloud FastAPI Backend

Secure backend API for the ReadAloud ebook reader with JWT authentication and Google Cloud TTS integration.

## Features

- **JWT Authentication**: Secure token-based authentication
- **User Management**: Register and login endpoints
- **Google Cloud TTS Proxy**: Secure proxy for Google Cloud Text-to-Speech API
- **Rate Limiting**: Built-in protection (ready for implementation)
- **CORS**: Configured for GitHub Pages frontend

## Setup

### 1. Install Dependencies

This project uses `uv` for package management:

```bash
# Install uv if you haven't already
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies
uv sync
```

### 2. Configure Google Cloud

1. Create a Google Cloud project
2. Enable the Text-to-Speech API
3. Create a service account and download the JSON credentials file
4. Place the credentials file in a secure location

### 3. Set Environment Variables

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Generate a secure secret key (run: openssl rand -hex 32)
SECRET_KEY=your-generated-secret-key-here

# Path to your Google Cloud credentials JSON file
GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/credentials.json

# Server configuration
PORT=8000
HOST=0.0.0.0
ACCESS_TOKEN_EXPIRE_MINUTES=30
```

### 4. Run the Server

**Development mode (with auto-reload):**

```bash
./run.sh
```

Or manually:

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

**Production mode:**

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
```

## API Endpoints

### Authentication

**POST `/api/register`**
- Register a new user
- Body: `{"username": "string", "password": "string"}`
- Returns: `{"access_token": "string", "token_type": "bearer"}`

**POST `/api/login`**
- Login with existing credentials
- Body: `{"username": "string", "password": "string"}`
- Returns: `{"access_token": "string", "token_type": "bearer"}`

### Text-to-Speech (Authenticated)

All TTS endpoints require `Authorization: Bearer <token>` header.

**GET `/api/voices`**
- Get available TTS voices
- Returns: `{"voices": [...]}`

**POST `/api/synthesize`**
- Synthesize text to speech
- Body: `{"text": "string", "voiceId": "string", "speed": 1.0, "pitch": 0}`
- Returns: `{"audioContent": "base64-string", "characterCount": number}`

### Health Check

**GET `/api/health`**
- Check API health
- Returns: `{"status": "ok", "timestamp": "ISO-8601"}`

## Security Notes

- User passwords are hashed with bcrypt
- JWT tokens expire after 30 minutes (configurable)
- API key never exposed to frontend
- CORS restricted to specific origins
- User data currently stored in-memory (use database in production)

## Production Deployment

### Using Railway

1. Create a Railway project
2. Add environment variables in Railway dashboard
3. Deploy from GitHub repository

### Using Fly.io

```bash
fly launch
fly secrets set SECRET_KEY=your-secret-key
fly secrets set GOOGLE_APPLICATION_CREDENTIALS=$(cat credentials.json)
fly deploy
```

### Using Docker

```bash
# Build image
docker build -t readaloud-api .

# Run container
docker run -p 8000:8000 \
  -e SECRET_KEY=your-secret \
  -e GOOGLE_APPLICATION_CREDENTIALS=/app/credentials.json \
  -v /path/to/credentials.json:/app/credentials.json \
  readaloud-api
```

## Development

**Run tests:**

```bash
uv run pytest
```

**Format code:**

```bash
uv run black .
uv run isort .
```

**Type checking:**

```bash
uv run mypy .
```

## Troubleshooting

**"Could not automatically find credentials"**
- Make sure `GOOGLE_APPLICATION_CREDENTIALS` points to valid credentials file
- Verify the service account has Text-to-Speech API access

**"Invalid authentication credentials"**
- Check that the `SECRET_KEY` matches between deployments
- Ensure JWT token hasn't expired

**CORS errors**
- Update `allow_origins` in `main.py` to include your frontend domain
- Make sure frontend sends proper `Authorization` header

## License

MIT License
