# Deploy FastAPI Backend to Google Cloud Run

Deploy your ReadAloud FastAPI backend to Google Cloud Run with the **free tier** (2M requests/month).

## Why Google Cloud Run?

✅ **Free Tier**: 2 million requests/month, 180k vCPU-seconds, 360k GiB-seconds
✅ **Python Native**: Full FastAPI support with all dependencies
✅ **Auto-scaling**: Scales to zero when not in use (no cost)
✅ **Easy Deployment**: One command deployment
✅ **Same Project**: Use same GCP project as your TTS API
✅ **Fast Cold Starts**: Better than most serverless platforms

## Prerequisites

1. Google Cloud account (same one with TTS API)
2. `gcloud` CLI installed
3. Your Google Cloud TTS credentials

## Setup

### 1. Install Google Cloud CLI

**Mac:**
```bash
brew install google-cloud-sdk
```

**Linux:**
```bash
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
```

**Windows:**
Download from: https://cloud.google.com/sdk/docs/install

### 2. Initialize and Login

```bash
# Login to your Google account
gcloud auth login

# Set your project (use the same project as your TTS API)
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com
```

### 3. Prepare Environment Variables

Create a `.env.yaml` file for Cloud Run (don't commit this):

```yaml
# .env.yaml
SECRET_KEY: "YOUR_GENERATED_SECRET_KEY_HERE"
GOOGLE_APPLICATION_CREDENTIALS: "/app/credentials.json"
```

Generate a secret key:
```bash
openssl rand -hex 32
```

### 4. Prepare Google Cloud Credentials

You have two options:

#### Option A: Use Service Account (Recommended)

```bash
# Create a service account for Cloud Run
gcloud iam service-accounts create readaloud-backend \
    --display-name="ReadAloud Backend"

# Grant TTS permissions
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
    --member="serviceAccount:readaloud-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/cloudtexttospeech.user"

# Deploy will automatically use this service account
```

#### Option B: Include Credentials File (Less Secure)

If you prefer to include the credentials file:

1. Download your service account JSON
2. Place it in the backend folder as `credentials.json`
3. Update Dockerfile to copy it:
```dockerfile
COPY credentials.json /app/credentials.json
```

### 5. Update FastAPI for Cloud Run

The existing `main.py` works! Just make sure CORS allows your domain:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://jamborta.github.io",  # Your GitHub Pages
        "http://localhost:8080"         # Local testing
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### 6. Deploy

⚠️ **CRITICAL: You MUST include `--env-vars-file .env.yaml` or the backend will not have SECRET_KEY and INVITATION_CODE!**

```bash
cd backend

# Deploy to Cloud Run - DO NOT SKIP ANY FLAGS
gcloud run deploy readaloud-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --env-vars-file .env.yaml \
  --service-account readaloud-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com

# If using Option B (credentials file), remove the --service-account flag
```

**What each flag does:**
- `--source .` - Build from current directory
- `--region us-central1` - Deploy to US Central region
- `--allow-unauthenticated` - Allow public access (required for frontend)
- **`--env-vars-file .env.yaml`** - ⚠️ **REQUIRED** - Loads SECRET_KEY and INVITATION_CODE
- `--service-account` - Use service account for Google Cloud permissions

**The deployment will:**
1. Build a container from your Dockerfile
2. Push it to Google Container Registry
3. Deploy to Cloud Run
4. Give you a URL like: `https://readaloud-backend-xxx-uc.a.run.app`

### 7. Update Frontend

Update `js/api.js` with your Cloud Run URL:

```javascript
const API_URL = 'https://readaloud-backend-xxx-uc.a.run.app';
```

Commit and push to GitHub Pages.

## Testing

```bash
# Get your service URL
gcloud run services describe readaloud-backend --region us-central1 --format 'value(status.url)'

# Test health endpoint
curl https://YOUR_CLOUD_RUN_URL/api/health

# Test register
curl -X POST https://YOUR_CLOUD_RUN_URL/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test123"}'
```

## Updating

After making changes:

```bash
# Redeploy with one command
gcloud run deploy readaloud-backend \
  --source . \
  --region us-central1
```

## Free Tier Limits

**Cloud Run Free Tier (per month):**
- 2,000,000 requests
- 180,000 vCPU-seconds
- 360,000 GiB-seconds
- 1 GB network egress

**Your usage estimate:**
- Average request: ~100ms CPU time
- 2M requests = 200,000 vCPU-seconds (within limit!)
- Text synthesis happens on TTS API (separate quota)

**You'll stay in free tier unless you get massive traffic.**

## Cost Monitoring

```bash
# View service details and costs
gcloud run services describe readaloud-backend --region us-central1

# Set up billing alerts
# Go to: https://console.cloud.google.com/billing/alerts
```

## Security Best Practices

### Environment Variables (Recommended)

Use Secret Manager instead of `.env.yaml`:

```bash
# Store secret in Secret Manager
echo -n "your-secret-key" | gcloud secrets create readaloud-secret-key --data-file=-

# Grant Cloud Run access
gcloud secrets add-iam-policy-binding readaloud-secret-key \
  --member="serviceAccount:readaloud-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Deploy with secret
gcloud run deploy readaloud-backend \
  --source . \
  --region us-central1 \
  --set-secrets="SECRET_KEY=readaloud-secret-key:latest"
```

### Database for Users (Production)

For production, replace in-memory `users_db` with:
- **Cloud Firestore** (NoSQL, free tier: 50k reads/day)
- **Cloud SQL** (PostgreSQL/MySQL, paid but cheap)
- **Firebase Auth** (managed auth, free tier generous)

## Troubleshooting

**"Could not find credentials"**
```bash
# Check service account permissions
gcloud projects get-iam-policy YOUR_PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:readaloud-backend@*"
```

**Container build fails**
```bash
# Build locally to debug
docker build -t readaloud-backend .
docker run -p 8080:8080 --env-file .env readaloud-backend
```

**High latency/cold starts**
```bash
# Set minimum instances (costs $, but faster)
gcloud run services update readaloud-backend \
  --min-instances=1 \
  --region us-central1
```

## Comparison: Cloud Run vs Cloudflare Workers

| Feature | Cloud Run | Cloudflare Workers |
|---------|-----------|-------------------|
| Python FastAPI | ✅ Full support | ❌ Limited (beta) |
| Free Tier | 2M req/month | 100k req/day |
| Dependencies | ✅ All packages | ❌ Limited |
| User Storage | ✅ In-memory/DB | ✅ KV storage |
| Cold Start | ~500ms | ~0ms |
| Deployment | `gcloud deploy` | `wrangler deploy` |
| Best For | Full Python apps | Edge/low-latency |

**Recommendation for ReadAloud:** Use **Google Cloud Run** since you're already using Google Cloud for TTS!

## Advanced: Custom Domain

```bash
# Map custom domain
gcloud run domain-mappings create \
  --service readaloud-backend \
  --domain api.yourdomain.com \
  --region us-central1
```

Then update DNS with the records provided.

## Cleanup

To delete everything:

```bash
gcloud run services delete readaloud-backend --region us-central1
gcloud iam service-accounts delete readaloud-backend@YOUR_PROJECT_ID.iam.gserviceaccount.com
```
