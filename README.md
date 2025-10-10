# ReadAloud - Ebook Reader with Google Cloud TTS

A modern, hostable ebook reader with high-quality text-to-speech powered by Google Cloud TTS. Read and listen to your favorite books with natural-sounding AI voices on any device, especially optimized for iPhone Safari.

## Features

### Reading
- Upload and manage EPUB and PDF files
- Clean, distraction-free reading interface
- Adjustable font sizes (4 levels)
- Multiple themes (Light, Sepia, Dark)
- Click paragraphs to jump to them
- Automatic reading position saving
- Fully client-side book storage

### Text-to-Speech
- **High-quality Google Cloud TTS** with WaveNet/Neural2 voices
- Multiple voice options (US, UK, Australian, Indian English)
- Adjustable playback speed (0.5x - 2x)
- Adjustable pitch (-5 to +5 semitones)
- Skip forward/back between paragraphs
- Visual paragraph highlighting during playback
- Audio caching for faster playback

### Usage Tracking
- Real-time character usage monitoring
- Free tier: 1 million characters/month
- Visual warnings at 75% and 90% usage
- Monthly usage reset

### Mobile Optimized
- iPhone Safari optimized (iOS 14+)
- 44px minimum touch targets (Apple HIG)
- Responsive design (320px - 2560px)
- PWA-ready with offline book reading
- Smooth scrolling and animations

## Tech Stack

**Frontend (GitHub Pages):**
- Pure HTML/CSS/JavaScript (no frameworks)
- PDF.js for PDF parsing
- IndexedDB for book storage
- localStorage for settings and positions

**Backend (Cloudflare Worker):**
- Secure proxy for Google Cloud TTS API
- Rate limiting and usage tracking
- Audio response caching
- CORS handling

**API:**
- Google Cloud Text-to-Speech API
- Free tier: 1M characters/month (~100 books)
- WaveNet/Neural2 voices

## Quick Start

### 1. Setup Google Cloud TTS

1. Create a [Google Cloud account](https://console.cloud.google.com/)
2. Enable the Text-to-Speech API
3. Create an API key:
   - Go to APIs & Services → Credentials
   - Create credentials → API Key
   - Restrict key to Text-to-Speech API only
4. Set usage quota (optional but recommended):
   - Go to IAM & Admin → Quotas
   - Set limit to 1M characters/month

### 2. Deploy Cloudflare Worker

```bash
# Install Wrangler CLI
npm install -g wrangler

# Navigate to worker directory
cd worker

# Login to Cloudflare
wrangler login

# Set your Google Cloud API key as a secret
wrangler secret put GOOGLE_CLOUD_API_KEY
# Paste your API key when prompted

# Deploy the worker
wrangler deploy

# Note the worker URL (e.g., https://readaloud-tts-worker.YOUR_SUBDOMAIN.workers.dev)
```

### 3. Configure Frontend

1. Open `js/api.js`
2. Update the `WORKER_URL` with your Cloudflare Worker URL:
   ```javascript
   const WORKER_URL = 'https://readaloud-tts-worker.YOUR_SUBDOMAIN.workers.dev';
   ```

### 4. Deploy to GitHub Pages

```bash
# Create a new GitHub repository
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/readaloud.git
git push -u origin main

# Enable GitHub Pages
# Go to Settings → Pages
# Source: Deploy from branch
# Branch: main
# Your app will be live at: https://YOUR_USERNAME.github.io/readaloud
```

### 5. Test

1. Open your GitHub Pages URL in Safari on iPhone (or any browser)
2. Upload a DRM-free EPUB or PDF file
3. Click on the book to open the reader
4. Press the play button to start text-to-speech

## Usage

### Adding Books

1. Click "Upload Book" on the library page
2. Select one or more EPUB or PDF files (DRM-free only)
3. Books will appear in your library grid
4. Metadata is extracted automatically

### Reading & Listening

**Controls:**
- **Play/Pause**: Start or stop text-to-speech
- **Skip**: Previous/next paragraph buttons
- **Voice**: Select from 15+ high-quality voices
- **Speed**: Adjust from 0.5x to 2x
- **Pitch**: Adjust from -5 to +5 semitones

**Customization:**
- **Font Size button (Aa)**: Cycle through 4 font sizes
- **Theme button (☀)**: Toggle Light → Sepia → Dark
- **Click paragraph**: Jump to any paragraph

**Reading Position:**
- Automatically saved when you leave
- Resume exactly where you left off
- Synced per book

### Managing Books

- **Open**: Click any book card
- **Delete**: Hover over book and click × button
- **Back to Library**: Click "← Library" in reader

## File Structure

```
readaloud/
├── index.html              # Library page
├── reader.html             # Reading interface
├── README.md               # This file
├── .gitignore             # Git ignore rules
│
├── css/
│   └── style.css          # All styling (themes, responsive)
│
├── js/
│   ├── app.js             # Library management
│   ├── reader.js          # Reading & TTS control
│   ├── storage.js         # IndexedDB & localStorage
│   └── api.js             # Cloudflare Worker API client
│
├── libs/
│   ├── pdf.min.js         # PDF.js library
│   └── pdf.worker.min.js  # PDF.js worker
│
└── worker/
    ├── index.js           # Cloudflare Worker code
    ├── wrangler.toml      # Worker configuration
    ├── .env.example       # API key template
    └── README.md          # Worker setup guide
```

## Browser Support

| Browser | Reading | TTS | Storage | Rating |
|---------|---------|-----|---------|--------|
| Safari iOS 14+ | ✅ | ✅ | ✅ | ⭐⭐⭐⭐⭐ Primary |
| Chrome (Desktop/Mobile) | ✅ | ✅ | ✅ | ⭐⭐⭐⭐⭐ Full |
| Firefox | ✅ | ✅ | ✅ | ⭐⭐⭐⭐ Full |
| Edge | ✅ | ✅ | ✅ | ⭐⭐⭐⭐⭐ Full |

## Storage Limits

**Browser Storage (IndexedDB):**
- Chrome/Edge: ~50-100 MB
- Firefox: ~50 MB
- Safari: ~50 MB

**Google Cloud TTS:**
- Free tier: 1,000,000 characters/month
- Average book: ~500,000 characters
- Approximate: 100 book reads/month free

**Tips:**
- Usage resets monthly
- Character count includes spaces
- Re-listening to cached paragraphs doesn't count

## Limitations

### Content
- Only DRM-free EPUB and PDF files
- PDF must have selectable text (not scanned images)
- Complex EPUB layouts may not render perfectly

### Technical
- Requires internet for text-to-speech (books work offline)
- Audio caching limited to last 20 paragraphs
- Storage limited by browser quota
- No cloud sync between devices

### Cost
- Free tier: 1M characters/month
- After free tier: $4-16 per million characters
- Cloudflare Worker: Free (up to 100k requests/day)
- GitHub Pages: Free forever

## Troubleshooting

### "TTS API is not configured" error
- Check that you updated `WORKER_URL` in `js/api.js`
- Verify your Cloudflare Worker is deployed

### "Failed to synthesize speech" error
- Check your internet connection
- Verify Google Cloud API key is valid
- Check you haven't exceeded quota (visit Google Cloud Console)

### Books won't upload
- Ensure files are EPUB or PDF format
- Check file isn't DRM-protected
- Try smaller files (under 10MB works best)

### PDF shows no text
- PDF must have text layer (not just images)
- Use OCR software first if needed

### No voices available
- Check internet connection
- Verify Cloudflare Worker is running
- Check browser console for errors

### Usage shows 0% but I used TTS
- Usage updates after each synthesis
- Check localStorage isn't cleared
- Verify date/time on your device is correct

## Security & Privacy

### Data Storage
- All books stored locally in your browser
- No data sent to external servers except TTS API
- Reading positions stored in localStorage
- No analytics or tracking

### API Security
- API key never exposed to frontend
- Secured in Cloudflare Worker environment variables
- Rate limiting prevents abuse
- CORS restricts access to your domain

### Recommendations
- Update CORS headers in `worker/index.js` to your domain only
- Consider adding authentication for production use
- Rotate API keys periodically
- Monitor usage in Google Cloud Console

## Customization

### Change Colors
Edit `css/style.css` CSS variables:
```css
:root {
    --primary-color: #4f46e5;  /* Main theme color */
    --text-color: #1f2937;      /* Text color */
    --bg-color: #f9fafb;        /* Background color */
}
```

### Add More Voices
Edit `worker/index.js` in the `handleGetVoices()` function to add voices from [Google's voice list](https://cloud.google.com/text-to-speech/docs/voices).

### Change Font Family
Edit `css/style.css`:
```css
body {
    font-family: 'Your Font', -apple-system, sans-serif;
}
```

### Adjust Storage Limits
Modify cache size in `js/reader.js`:
```javascript
if (this.audioCache.size > 20) { // Change 20 to your preferred cache size
```

## Cost Optimization

### Free Tier Strategies
1. **Cache aggressively**: Re-listening uses cached audio (free)
2. **Monitor usage**: Check usage display regularly
3. **Shorter sessions**: Stop playback when not actively listening
4. **Font size**: Larger fonts = fewer characters per screen

### Going Over Free Tier
After 1M characters:
- **Standard voices**: ~$4 per 1M characters
- **WaveNet voices**: ~$16 per 1M characters
- **Neural2 voices**: ~$16 per 1M characters

Set spending limits in Google Cloud Console.

## Development

### Local Testing

```bash
# Test Cloudflare Worker locally
cd worker
wrangler dev

# Serve frontend locally (use any static server)
python3 -m http.server 8000
# Or
npx serve
```

### Making Changes

1. Fork the repository
2. Make your changes
3. Test thoroughly on iPhone Safari
4. Submit a pull request

## Contributing

Contributions welcome! Please:
- Test on iPhone Safari
- Follow existing code style
- Update documentation
- Add comments for complex logic

## License

MIT License - Free to use, modify, and distribute.

## Credits

- Built with vanilla JavaScript
- PDF.js by Mozilla Foundation
- Google Cloud Text-to-Speech
- Cloudflare Workers
- Hosted on GitHub Pages

## Support

- Issues: [GitHub Issues](https://github.com/YOUR_USERNAME/readaloud/issues)
- Docs: This README
- Google Cloud TTS Docs: https://cloud.google.com/text-to-speech/docs
- Cloudflare Workers Docs: https://developers.cloudflare.com/workers

---

**Made with ❤️ for book lovers everywhere**

Enjoy reading and listening!
