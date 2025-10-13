/**
 * API Client for communicating with FastAPI Backend
 */

// IMPORTANT: Update this URL after deploying your FastAPI backend
const API_URL = 'https://readaloud-backend-63970619665.us-central1.run.app';

class TTSApiClient {
    constructor() {
        this.apiUrl = API_URL;
        this.isOnline = navigator.onLine;
        this.token = localStorage.getItem('auth_token');

        // Listen for online/offline events
        window.addEventListener('online', () => this.isOnline = true);
        window.addEventListener('offline', () => this.isOnline = false);
    }

    /**
     * Check if user is authenticated
     */
    isAuthenticated() {
        return !!this.token;
    }

    /**
     * Register a new user
     */
    async register(username, password, invitationCode) {
        if (!this.isOnline) {
            throw new Error('No internet connection');
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password, invitationCode })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Registration failed');
            }

            const data = await response.json();
            this.token = data.access_token;
            localStorage.setItem('auth_token', this.token);
            return data;
        } catch (error) {
            console.error('Registration failed:', error);
            throw error;
        }
    }

    /**
     * Login with existing credentials
     */
    async login(username, password) {
        if (!this.isOnline) {
            throw new Error('No internet connection');
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Login failed');
            }

            const data = await response.json();
            this.token = data.access_token;
            localStorage.setItem('auth_token', this.token);
            return data;
        } catch (error) {
            console.error('Login failed:', error);
            throw error;
        }
    }

    /**
     * Logout and clear token
     */
    logout() {
        this.token = null;
        localStorage.removeItem('auth_token');
    }

    /**
     * Get authorization headers
     */
    getAuthHeaders() {
        if (!this.token) {
            throw new Error('Not authenticated');
        }
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Check if the API is available
     */
    async checkHealth() {
        if (!this.isOnline) {
            throw new Error('No internet connection');
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/health`, {
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

        if (!this.isAuthenticated()) {
            throw new Error('Please login to access voices');
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/voices`, {
                method: 'GET',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                if (response.status === 401) {
                    this.logout();
                    throw new Error('Session expired. Please login again.');
                }
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

        if (!this.isAuthenticated()) {
            throw new Error('Please login to use text-to-speech');
        }

        if (!text || text.trim().length === 0) {
            throw new Error('Text cannot be empty');
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/synthesize`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    text: text.trim(),
                    voiceId,
                    speed,
                    pitch
                })
            });

            if (!response.ok) {
                if (response.status === 401) {
                    this.logout();
                    throw new Error('Session expired. Please login again.');
                }
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to synthesize speech');
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
     * Get all books from backend
     */
    async getBooks() {
        if (!this.isOnline) {
            throw new Error('No internet connection');
        }

        if (!this.isAuthenticated()) {
            throw new Error('Please login to sync books');
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/books`, {
                method: 'GET',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                if (response.status === 401) {
                    this.logout();
                    throw new Error('Session expired. Please login again.');
                }
                throw new Error('Failed to fetch books');
            }

            const data = await response.json();
            return data.books;
        } catch (error) {
            console.error('Failed to get books:', error);
            throw error;
        }
    }

    /**
     * Save book metadata to backend
     */
    async saveBook(bookMetadata) {
        if (!this.isOnline) {
            throw new Error('No internet connection');
        }

        if (!this.isAuthenticated()) {
            throw new Error('Please login to sync books');
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/books`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(bookMetadata)
            });

            if (!response.ok) {
                if (response.status === 401) {
                    this.logout();
                    throw new Error('Session expired. Please login again.');
                }
                throw new Error('Failed to save book');
            }

            return await response.json();
        } catch (error) {
            console.error('Failed to save book:', error);
            throw error;
        }
    }

    /**
     * Download book file from backend
     */
    async downloadBook(bookId) {
        if (!this.isOnline) {
            throw new Error('No internet connection');
        }

        if (!this.isAuthenticated()) {
            throw new Error('Please login to download books');
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/books/${bookId}/download`, {
                method: 'GET',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                if (response.status === 401) {
                    this.logout();
                    throw new Error('Session expired. Please login again.');
                }
                throw new Error('Failed to download book');
            }

            return await response.json();
        } catch (error) {
            console.error('Failed to download book:', error);
            throw error;
        }
    }

    /**
     * Delete book from backend
     */
    async deleteBook(bookId) {
        if (!this.isOnline) {
            throw new Error('No internet connection');
        }

        if (!this.isAuthenticated()) {
            throw new Error('Please login to sync books');
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/books/${bookId}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                if (response.status === 401) {
                    this.logout();
                    throw new Error('Session expired. Please login again.');
                }
                throw new Error('Failed to delete book');
            }

            return await response.json();
        } catch (error) {
            console.error('Failed to delete book:', error);
            throw error;
        }
    }

    /**
     * Get reading position from backend
     */
    async getPosition(bookId) {
        if (!this.isOnline) {
            return null; // Offline, use local position
        }

        if (!this.isAuthenticated()) {
            return null;
        }

        try {
            const response = await fetch(`${this.apiUrl}/api/positions/${bookId}`, {
                method: 'GET',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                return null;
            }

            return await response.json();
        } catch (error) {
            console.error('Failed to get position:', error);
            return null;
        }
    }

    /**
     * Save reading position to backend
     */
    async savePosition(position) {
        if (!this.isOnline) {
            return; // Will sync when online
        }

        if (!this.isAuthenticated()) {
            return;
        }

        try {
            console.log('Sending position to backend:', position);
            const response = await fetch(`${this.apiUrl}/api/positions`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(position)
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Failed to save position:', response.status, errorText);
            }
        } catch (error) {
            console.error('Failed to save position:', error);
        }
    }

    /**
     * Check if API URL is configured
     */
    isConfigured() {
        return this.apiUrl !== 'https://your-api-url.com';
    }
}

// Create global instance
const ttsApi = new TTSApiClient();
