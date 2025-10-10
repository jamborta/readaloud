# Deploying Backend to Cloudflare Workers

This guide covers deploying the ReadAloud backend as a Cloudflare Worker (JavaScript version with JWT auth).

## Why JavaScript Worker Instead of Python?

While Cloudflare supports FastAPI in Python Workers, it's currently in beta with limitations:
- Packages (like `google-cloud-texttospeech`, `python-jose`) cannot be deployed to production
- Only Python standard library is supported in production

The JavaScript worker provides:
- Full production support
- JWT authentication with `jose` library
- KV storage for users
- Same security features as FastAPI version

## Prerequisites

1. Cloudflare account
2. Wrangler CLI installed
3. Google Cloud API key

## Setup Steps

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Login to Cloudflare

```bash
npx wrangler login
```

### 3. Create KV Namespace

```bash
# Create production KV namespace
npx wrangler kv:namespace create USERS_KV

# Note the ID returned, it will look like:
# { binding = "USERS_KV", id = "abc123..." }
```

Update `wrangler.toml` with the KV namespace ID:

```toml
[[kv_namespaces]]
binding = "USERS_KV"
id = "your-actual-kv-namespace-id-here"
```

### 4. Set Secrets

```bash
# Generate a secure secret key
SECRET_KEY=$(openssl rand -hex 32)

# Set the secret key
npx wrangler secret put SECRET_KEY
# Paste the generated key when prompted

# Set Google Cloud API key
npx wrangler secret put GOOGLE_CLOUD_API_KEY
# Paste your Google Cloud API key
```

### 5. Deploy

```bash
# Deploy to production
npx wrangler deploy

# Your worker will be available at:
# https://readaloud-backend.YOUR_SUBDOMAIN.workers.dev
```

### 6. Update Frontend

Update `js/api.js` with your worker URL:

```javascript
const API_URL = 'https://readaloud-backend.YOUR_SUBDOMAIN.workers.dev';
```

## Testing

### Local Development

```bash
# Run locally with hot reload
npx wrangler dev

# Test with curl
curl http://localhost:8787/api/health
```

### Test Endpoints

**Health check:**
```bash
curl https://readaloud-backend.YOUR_SUBDOMAIN.workers.dev/api/health
```

**Register:**
```bash
curl -X POST https://readaloud-backend.YOUR_SUBDOMAIN.workers.dev/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"testpass123"}'
```

**Login:**
```bash
curl -X POST https://readaloud-backend.YOUR_SUBDOMAIN.workers.dev/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"testpass123"}'
```

**Get voices (authenticated):**
```bash
curl https://readaloud-backend.YOUR_SUBDOMAIN.workers.dev/api/voices \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## CORS Configuration

Update the `CORS_HEADERS` in `worker.js` to match your frontend domain:

```javascript
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://YOUR_USERNAME.github.io',
  // ... rest of headers
};
```

## Monitoring

View logs and analytics in the Cloudflare dashboard:
1. Go to Workers & Pages
2. Select your worker
3. View Metrics and Logs tabs

## Cost

Cloudflare Workers Free Tier:
- 100,000 requests/day
- 10ms CPU time per request
- KV: 100,000 reads/day, 1,000 writes/day

This is more than enough for personal use. If you exceed limits, pricing is very affordable.

## Updating

To update the worker after making changes:

```bash
npx wrangler deploy
```

## Troubleshooting

**"Unknown binding USERS_KV"**
- Make sure you created the KV namespace and updated the ID in `wrangler.toml`

**"Could not find SECRET_KEY"**
- Set secrets with `npx wrangler secret put SECRET_KEY`

**CORS errors**
- Update `CORS_HEADERS` in `worker.js` to include your frontend domain

**"Invalid API key" from Google**
- Check that `GOOGLE_CLOUD_API_KEY` is set correctly
- Verify the API key has Text-to-Speech API enabled

## Comparison: FastAPI vs JavaScript Worker

| Feature | FastAPI (Python) | JavaScript Worker |
|---------|------------------|-------------------|
| Production Ready | ❌ Beta only | ✅ Fully supported |
| External Packages | ❌ Dev only | ✅ Full support |
| JWT Auth | ✅ python-jose | ✅ jose library |
| User Storage | ⚠️ In-memory | ✅ KV persistent |
| Google Cloud TTS | ✅ Native client | ✅ REST API |
| Deployment | ⚠️ Limited | ✅ Simple |
| Cold Start | Slower | Faster |

**Recommendation:** Use the JavaScript worker for production deployment. The FastAPI version (`main.py`) can still be used for local development if you prefer Python.

## Alternative: Keep FastAPI for Self-Hosting

If you prefer FastAPI, you can deploy it to:
- **Railway**: `railway up` (automatic deployment)
- **Fly.io**: `fly launch` (Dockerfile needed)
- **DigitalOcean App Platform**: Connect GitHub repo
- **Your own server**: Run with `uvicorn main:app --host 0.0.0.0 --port 8000`

Then update the frontend `API_URL` to point to your deployed backend.
