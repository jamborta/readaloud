# Cloudflare Worker for ReadAloud TTS

This worker acts as a secure proxy between the frontend and Google Cloud Text-to-Speech API.

## Setup

### Prerequisites

1. [Node.js](https://nodejs.org/) (v16 or later)
2. [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
3. [Google Cloud account](https://console.cloud.google.com/) with TTS API enabled

### Steps

1. **Install Wrangler CLI**
   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare**
   ```bash
   wrangler login
   ```

3. **Get Google Cloud API Key**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Enable Text-to-Speech API
   - Create credentials → API Key
   - Restrict the key to Text-to-Speech API only

4. **Set API Key as Secret**
   ```bash
   cd worker
   wrangler secret put GOOGLE_CLOUD_API_KEY
   # Paste your API key when prompted
   ```

5. **Deploy Worker**
   ```bash
   wrangler deploy
   ```

6. **Get Worker URL**
   After deployment, you'll see your worker URL:
   ```
   https://readaloud-tts-worker.YOUR_SUBDOMAIN.workers.dev
   ```

7. **Update Frontend**
   Copy the worker URL and update `js/api.js` in the frontend:
   ```javascript
   const WORKER_URL = 'https://readaloud-tts-worker.YOUR_SUBDOMAIN.workers.dev';
   ```

## Development

Test locally:
```bash
wrangler dev
```

## Security Notes

- Never commit `.env` file with real API keys
- Update CORS headers in `index.js` to restrict to your domain
- Consider adding authentication for production use
- Monitor usage in Google Cloud Console to avoid unexpected charges

## Cost

- Cloudflare Workers: Free (100k requests/day)
- Google Cloud TTS: Free tier (1M characters/month)
- After free tier: ~$4-16 per million characters
