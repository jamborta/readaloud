/**
 * API Client for communicating with Cloudflare Worker
 */

// IMPORTANT: Update this URL after deploying your Cloudflare Worker
const WORKER_URL = 'https://readaloud-tts-worker.jamborta.workers.dev';

class TTSApiClient {
    constructor() {
        this.workerUrl = WORKER_URL;
        this.isOnline = navigator.onLine;

        // Listen for online/offline events
        window.addEventListener('online', () => this.isOnline = true);
        window.addEventListener('offline', () => this.isOnline = false);
    }

    /**
     * Check if the API is available
     */
    async checkHealth() {
        if (!this.isOnline) {
            throw new Error('No internet connection');
        }

        try {
            const response = await fetch(`${this.workerUrl}/api/health`, {
                method: 'GET'
            });

            if (!response.ok) {
                throw new Error('API health check failed');
            }

            return await response.json();
        } catch (error) {
            console.error('Health check failed:', error);
            throw error;
        }
    }

    /**
     * Get available voices from the API
     */
    async getVoices() {
        if (!this.isOnline) {
            throw new Error('No internet connection');
        }

        try {
            const response = await fetch(`${this.workerUrl}/api/voices`, {
                method: 'GET'
            });

            if (!response.ok) {
                throw new Error('Failed to fetch voices');
            }

            const data = await response.json();
            return data.voices;
        } catch (error) {
            console.error('Failed to get voices:', error);
            throw error;
        }
    }

    /**
     * Synthesize text to speech
     * @param {string} text - Text to synthesize
     * @param {string} voiceId - Voice ID (e.g., 'en-US-Neural2-A')
     * @param {number} speed - Speaking rate (0.25 - 4.0)
     * @param {number} pitch - Pitch adjustment (-20.0 to 20.0)
     * @returns {Promise<{audioContent: string, characterCount: number}>}
     */
    async synthesize(text, voiceId, speed = 1.0, pitch = 0) {
        if (!this.isOnline) {
            throw new Error('No internet connection. Text-to-speech requires internet access.');
        }

        if (!text || text.trim().length === 0) {
            throw new Error('Text cannot be empty');
        }

        try {
            const response = await fetch(`${this.workerUrl}/api/synthesize`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: text.trim(),
                    voiceId,
                    speed,
                    pitch
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to synthesize speech');
            }

            const data = await response.json();
            return data;
        } catch (error) {
            console.error('Synthesis error:', error);
            throw error;
        }
    }

    /**
     * Convert base64 audio to playable audio element
     * @param {string} base64Audio - Base64 encoded audio data
     * @returns {HTMLAudioElement}
     */
    createAudioElement(base64Audio) {
        const audio = new Audio();
        audio.src = `data:audio/mp3;base64,${base64Audio}`;
        return audio;
    }

    /**
     * Check if worker URL is configured
     */
    isConfigured() {
        return this.workerUrl !== 'https://readaloud-tts-worker.YOUR_SUBDOMAIN.workers.dev';
    }
}

// Create global instance
const ttsApi = new TTSApiClient();
