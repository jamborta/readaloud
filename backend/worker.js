/**
 * Cloudflare Worker - ReadAloud Backend with JWT Authentication
 * JavaScript implementation for full Cloudflare Workers compatibility
 */

import { SignJWT, jwtVerify } from 'jose';

// Configuration
const ALGORITHM = 'HS256';
const TOKEN_EXPIRY = '30m';
const MAX_CHARS_PER_REQUEST = 5000;

// CORS headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://jamborta.github.io',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      // Route requests
      if (url.pathname === '/api/register' && request.method === 'POST') {
        return await handleRegister(request, env);
      } else if (url.pathname === '/api/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      } else if (url.pathname === '/api/voices' && request.method === 'GET') {
        return await handleGetVoices(request, env);
      } else if (url.pathname === '/api/synthesize' && request.method === 'POST') {
        return await handleSynthesize(request, env);
      } else if (url.pathname === '/api/health' && request.method === 'GET') {
        return jsonResponse({ status: 'ok', timestamp: Date.now() });
      } else if (url.pathname === '/' && request.method === 'GET') {
        return jsonResponse({ message: 'ReadAloud API', version: '2.0.0' });
      } else {
        return jsonResponse({ error: 'Not found' }, 404);
      }
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ error: 'Internal server error', detail: error.message }, 500);
    }
  },
};

// Authentication handlers
async function handleRegister(request, env) {
  try {
    const body = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return jsonResponse({ detail: 'Username and password required' }, 400);
    }

    if (password.length < 6) {
      return jsonResponse({ detail: 'Password must be at least 6 characters' }, 400);
    }

    // Check if user exists in KV
    const existingUser = await env.USERS_KV.get(`user:${username}`);
    if (existingUser) {
      return jsonResponse({ detail: 'Username already exists' }, 400);
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Store user in KV
    const userData = {
      username,
      hashedPassword,
      createdAt: new Date().toISOString(),
    };
    await env.USERS_KV.put(`user:${username}`, JSON.stringify(userData));

    // Generate JWT token
    const token = await generateToken(username, env.SECRET_KEY);

    return jsonResponse({
      access_token: token,
      token_type: 'bearer',
    });
  } catch (error) {
    console.error('Register error:', error);
    return jsonResponse({ detail: 'Registration failed' }, 500);
  }
}

async function handleLogin(request, env) {
  try {
    const body = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return jsonResponse({ detail: 'Username and password required' }, 400);
    }

    // Get user from KV
    const userDataStr = await env.USERS_KV.get(`user:${username}`);
    if (!userDataStr) {
      return jsonResponse({ detail: 'Incorrect username or password' }, 401);
    }

    const userData = JSON.parse(userDataStr);

    // Verify password
    const isValid = await verifyPassword(password, userData.hashedPassword);
    if (!isValid) {
      return jsonResponse({ detail: 'Incorrect username or password' }, 401);
    }

    // Generate JWT token
    const token = await generateToken(username, env.SECRET_KEY);

    return jsonResponse({
      access_token: token,
      token_type: 'bearer',
    });
  } catch (error) {
    console.error('Login error:', error);
    return jsonResponse({ detail: 'Login failed' }, 500);
  }
}

// TTS handlers (authenticated)
async function handleGetVoices(request, env) {
  // Verify authentication
  const username = await verifyAuth(request, env);
  if (!username) {
    return jsonResponse({ detail: 'Unauthorized' }, 401);
  }

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

async function handleSynthesize(request, env) {
  // Verify authentication
  const username = await verifyAuth(request, env);
  if (!username) {
    return jsonResponse({ detail: 'Unauthorized' }, 401);
  }

  try {
    const body = await request.json();
    const { text, voiceId, speed = 1.0, pitch = 0 } = body;

    // Validate input
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return jsonResponse({ detail: 'Invalid text parameter' }, 400);
    }

    if (text.length > MAX_CHARS_PER_REQUEST) {
      return jsonResponse({
        detail: `Text exceeds maximum length of ${MAX_CHARS_PER_REQUEST} characters`,
      }, 400);
    }

    if (!voiceId || typeof voiceId !== 'string') {
      return jsonResponse({ detail: 'Invalid voiceId parameter' }, 400);
    }

    // Extract language code (e.g., "en-US" from "en-US-Neural2-A")
    const languageCode = voiceId.split('-').slice(0, 2).join('-');

    // Build Google Cloud TTS request
    const ttsRequest = {
      input: { text: text.trim() },
      voice: {
        languageCode,
        name: voiceId,
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: Math.max(0.25, Math.min(4.0, speed)),
        pitch: Math.max(-20.0, Math.min(20.0, pitch)),
        sampleRateHertz: 24000,
      },
    };

    // Call Google Cloud TTS API
    const ttsUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GOOGLE_CLOUD_API_KEY}`;

    const response = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ttsRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Google TTS API error:', errorText);
      return jsonResponse({
        detail: 'Text-to-speech service error',
        error: response.status === 403 ? 'Invalid API key or quota exceeded' : 'Service unavailable',
      }, response.status);
    }

    const ttsResponse = await response.json();

    return jsonResponse({
      audioContent: ttsResponse.audioContent,
      characterCount: text.length,
    });
  } catch (error) {
    console.error('Synthesis error:', error);
    return jsonResponse({ detail: 'Failed to synthesize speech' }, 500);
  }
}

// Helper functions
async function verifyAuth(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.substring(7);
    const secret = new TextEncoder().encode(env.SECRET_KEY);

    const { payload } = await jwtVerify(token, secret, {
      algorithms: [ALGORITHM],
    });

    return payload.sub; // username
  } catch (error) {
    console.error('Auth verification error:', error);
    return null;
  }
}

async function generateToken(username, secretKey) {
  const secret = new TextEncoder().encode(secretKey);

  const token = await new SignJWT({ sub: username })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(secret);

  return token;
}

async function hashPassword(password) {
  // Use Web Crypto API for password hashing
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, hashedPassword) {
  const hash = await hashPassword(password);
  return hash === hashedPassword;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
