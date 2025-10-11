/**
 * Cloudflare Worker for Google Cloud TTS Proxy
 * Securely proxies requests to Google Cloud Text-to-Speech API
 */

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS_PER_WINDOW = 100;
const MAX_CHARS_PER_REQUEST = 5000;

// CORS headers for frontend
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://jamborta.github.io', // Only your domain
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }

  const url = new URL(request.url);

  try {
    // Route requests
    if (url.pathname === '/api/synthesize' && request.method === 'POST') {
      return await handleSynthesize(request);
    } else if (url.pathname === '/api/voices' && request.method === 'GET') {
      return await handleGetVoices(request);
    } else if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok', timestamp: Date.now() });
    } else {
      return jsonResponse({ error: 'Not found' }, 404);
    }
  } catch (error) {
    console.error('Worker error:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}

async function handleSynthesize(request) {
  // Check API key authentication
  const authHeader = request.headers.get('X-API-Key');
  if (!authHeader || authHeader !== API_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Check rate limit
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitKey = `ratelimit:${clientIP}`;

  const rateLimitResult = await checkRateLimit(rateLimitKey);
  if (!rateLimitResult.allowed) {
    return jsonResponse({
      error: 'Rate limit exceeded',
      retryAfter: rateLimitResult.retryAfter
    }, 429);
  }

  // Parse request
  const body = await request.json();
  const { text, voiceId, speed, pitch } = body;

  // Validate input
  if (!text || typeof text !== 'string') {
    return jsonResponse({ error: 'Invalid text parameter' }, 400);
  }

  if (text.length > MAX_CHARS_PER_REQUEST) {
    return jsonResponse({
      error: `Text exceeds maximum length of ${MAX_CHARS_PER_REQUEST} characters`
    }, 400);
  }

  if (!voiceId || typeof voiceId !== 'string') {
    return jsonResponse({ error: 'Invalid voiceId parameter' }, 400);
  }

  // Default values
  const speakingRate = speed || 1.0;
  const pitchValue = pitch || 0;

  // Build Google Cloud TTS request
  const ttsRequest = {
    input: { text },
    voice: {
      languageCode: voiceId.split('-').slice(0, 2).join('-'), // Extract language code (e.g., "en-US")
      name: voiceId
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: Math.max(0.25, Math.min(4.0, speakingRate)),
      pitch: Math.max(-20.0, Math.min(20.0, pitchValue)),
      sampleRateHertz: 24000
    }
  };

  // Call Google Cloud TTS API
  const apiKey = GOOGLE_CLOUD_API_KEY; // Set via wrangler secret
  const ttsUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;

  const response = await fetch(ttsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ttsRequest)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Google TTS API error:', errorText);
    return jsonResponse({
      error: 'Text-to-speech service error',
      details: response.status === 403 ? 'Invalid API key or quota exceeded' : 'Service unavailable'
    }, response.status);
  }

  const ttsResponse = await response.json();

  // Return audio content
  return jsonResponse({
    audioContent: ttsResponse.audioContent,
    characterCount: text.length
  });
}

async function handleGetVoices(request) {
  // Return curated list of high-quality voices
  const voices = [
    // English (US)
    { id: 'en-US-Neural2-A', name: 'US English (Female, Neural)', language: 'en-US', gender: 'FEMALE' },
    { id: 'en-US-Neural2-C', name: 'US English (Male, Neural)', language: 'en-US', gender: 'MALE' },
    { id: 'en-US-Neural2-D', name: 'US English (Male, Neural)', language: 'en-US', gender: 'MALE' },
    { id: 'en-US-Neural2-E', name: 'US English (Female, Neural)', language: 'en-US', gender: 'FEMALE' },
    { id: 'en-US-Neural2-F', name: 'US English (Female, Neural)', language: 'en-US', gender: 'FEMALE' },

    // English (UK)
    { id: 'en-GB-Neural2-A', name: 'UK English (Female, Neural)', language: 'en-GB', gender: 'FEMALE' },
    { id: 'en-GB-Neural2-B', name: 'UK English (Male, Neural)', language: 'en-GB', gender: 'MALE' },
    { id: 'en-GB-Neural2-C', name: 'UK English (Female, Neural)', language: 'en-GB', gender: 'FEMALE' },
    { id: 'en-GB-Neural2-D', name: 'UK English (Male, Neural)', language: 'en-GB', gender: 'MALE' },

    // English (AU)
    { id: 'en-AU-Neural2-A', name: 'Australian English (Female, Neural)', language: 'en-AU', gender: 'FEMALE' },
    { id: 'en-AU-Neural2-B', name: 'Australian English (Male, Neural)', language: 'en-AU', gender: 'MALE' },
    { id: 'en-AU-Neural2-C', name: 'Australian English (Female, Neural)', language: 'en-AU', gender: 'FEMALE' },
    { id: 'en-AU-Neural2-D', name: 'Australian English (Male, Neural)', language: 'en-AU', gender: 'MALE' },

    // English (IN)
    { id: 'en-IN-Neural2-A', name: 'Indian English (Female, Neural)', language: 'en-IN', gender: 'FEMALE' },
    { id: 'en-IN-Neural2-B', name: 'Indian English (Male, Neural)', language: 'en-IN', gender: 'MALE' },
  ];

  return jsonResponse({ voices });
}

async function checkRateLimit(key) {
  // Simple in-memory rate limiting (use KV for persistent storage in production)
  // This is a basic implementation - in production, use Cloudflare KV or Durable Objects

  // For now, we'll allow all requests but track them
  // TODO: Implement proper rate limiting with KV storage

  return {
    allowed: true,
    retryAfter: 0
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}
