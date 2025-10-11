// Reader and Google Cloud TTS Manager
class BookReader {
    constructor() {
        this.bookId = null;
        this.book = null;
        this.currentParagraphs = [];
        this.currentParagraphIndex = 0;
        this.isPlaying = false;
        this.currentAudio = null;
        this.voices = [];
        this.audioCache = new Map(); // Cache synthesized audio
        this.isLoadingAudio = false;
    }

    async init() {
        // Check if API is configured
        if (!ttsApi.isConfigured()) {
            alert('TTS API is not configured. Please update the API_URL in js/api.js');
        }

        // Get book ID from URL
        const urlParams = new URLSearchParams(window.location.search);
        this.bookId = urlParams.get('bookId');

        if (!this.bookId) {
            alert('No book selected!');
            window.location.href = 'index.html';
            return;
        }

        // Initialize storage and load book
        await storage.init();
        this.book = await storage.getBook(this.bookId);

        if (!this.book) {
            alert('Book not found!');
            window.location.href = 'index.html';
            return;
        }

        // Setup UI
        this.setupUI();
        this.loadSettings();
        await this.renderBook();
        this.loadReadingPosition();
        this.setupEventListeners();
        this.updateUsageDisplay();

        // Load voices if authenticated, otherwise show placeholder
        if (ttsApi.isAuthenticated()) {
            try {
                await this.loadVoices();
            } catch (error) {
                console.error('Failed to load voices:', error);
                document.getElementById('voice-select').innerHTML = '<option>Login to load voices</option>';
            }
        } else {
            // Not authenticated - show friendly message
            document.getElementById('voice-select').innerHTML = '<option>Login to load voices</option>';
        }
    }

    setupUI() {
        document.getElementById('book-title').textContent = this.book.title;
    }

    setupEventListeners() {
        // Back button
        document.getElementById('back-btn').addEventListener('click', async () => {
            await this.saveReadingPosition();
            window.location.href = 'index.html';
        });

        // TTS Controls
        document.getElementById('play-pause').addEventListener('click', () => this.togglePlayPause());
        document.getElementById('prev-paragraph').addEventListener('click', () => this.previousParagraph());
        document.getElementById('next-paragraph').addEventListener('click', () => this.nextParagraph());

        // Speed control
        document.getElementById('speed-select').addEventListener('change', (e) => {
            const speed = parseFloat(e.target.value);
            storage.saveSettings({ speed });
            // Clear cache when speed changes
            this.audioCache.clear();
        });

        // Pitch control
        document.getElementById('pitch-select').addEventListener('change', (e) => {
            const pitch = parseFloat(e.target.value);
            storage.saveSettings({ pitch });
            // Clear cache when pitch changes
            this.audioCache.clear();
        });

        // Voice control
        document.getElementById('voice-select').addEventListener('change', (e) => {
            storage.saveSettings({ voiceId: e.target.value });
            // Clear cache when voice changes
            this.audioCache.clear();
        });

        // Font size control
        document.getElementById('font-size-btn').addEventListener('click', () => {
            this.cycleFontSize();
        });

        // Theme toggle
        document.getElementById('theme-btn').addEventListener('click', () => {
            this.cycleTheme();
        });

        // Save position before leaving
        window.addEventListener('beforeunload', () => {
            this.saveReadingPosition();
        });
    }

    async loadVoices() {
        try {
            this.voices = await ttsApi.getVoices();
            const voiceSelect = document.getElementById('voice-select');

            if (this.voices.length > 0) {
                voiceSelect.innerHTML = this.voices.map(voice => {
                    return `<option value="${voice.id}">${voice.name}</option>`;
                }).join('');

                // Restore saved voice selection after populating options
                const settings = storage.getSettings();
                if (settings.voiceId) {
                    voiceSelect.value = settings.voiceId;
                }
            }
        } catch (error) {
            console.error('Failed to load voices:', error);
            if (error.message.includes('login')) {
                // Will be prompted to login when trying to play
                document.getElementById('voice-select').innerHTML = '<option>Login to load voices</option>';
            } else {
                alert('Failed to load voices. Please check your internet connection and API configuration.');
            }
        }
    }

    loadSettings() {
        const settings = storage.getSettings();

        // Set speed
        document.getElementById('speed-select').value = settings.speed || 1.0;

        // Set pitch
        document.getElementById('pitch-select').value = settings.pitch || 0;

        // Set voice if saved
        if (settings.voiceId) {
            document.getElementById('voice-select').value = settings.voiceId;
        }

        // Set font size
        const fontSize = settings.fontSize || 'medium';
        document.body.setAttribute('data-font-size', fontSize);

        // Set theme
        const theme = settings.theme || 'light';
        document.body.setAttribute('data-theme', theme);
    }

    async renderBook() {
        const content = document.getElementById('reader-content');

        if (this.book.fileType === 'pdf') {
            await this.renderPDF(content);
        } else {
            await this.renderEPUB(content);
        }

        // Get all paragraphs
        this.currentParagraphs = Array.from(content.querySelectorAll('p'));

        // Add click handlers to paragraphs
        this.currentParagraphs.forEach((p, index) => {
            p.addEventListener('click', () => {
                this.jumpToParagraph(index);
            });
        });

        this.updateProgress();
    }

    async renderPDF(container) {
        try {
            const uint8Array = new Uint8Array(this.book.fileData);

            if (typeof pdfjsLib === 'undefined') {
                container.innerHTML = '<p>PDF.js library not loaded. PDF reading is not available.</p>';
                return;
            }

            pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';

            const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
            const pdf = await loadingTask.promise;

            container.innerHTML = '<div class="pdf-text"></div>';
            const textContainer = container.querySelector('.pdf-text');

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const text = textContent.items.map(item => item.str).join(' ');

                const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
                paragraphs.forEach(para => {
                    const p = document.createElement('p');
                    p.textContent = para.trim();
                    textContainer.appendChild(p);
                });
            }
        } catch (error) {
            console.error('Error rendering PDF:', error);
            container.innerHTML = '<p>Error loading PDF. This might be a complex PDF that cannot be read as text.</p>';
        }
    }

    async renderEPUB(container) {
        try {
            const uint8Array = new Uint8Array(this.book.fileData);

            // Check if epub.js is loaded
            if (typeof ePub === 'undefined') {
                container.innerHTML = '<p>EPUB library not loaded. Please refresh the page.</p>';
                return;
            }

            console.log('Loading EPUB with epub.js...');

            // Create book instance from array buffer
            const book = ePub(uint8Array.buffer);

            // Wait for book to be ready
            await book.ready;
            console.log('EPUB ready, loading spine...');

            // Wait for spine to load
            const spine = await book.loaded.spine;
            console.log(`Processing ${spine.items.length} spine items...`);

            // Extract text from all sections
            const textPromises = [];
            spine.each((item) => {
                textPromises.push(
                    item.load(book.load.bind(book)).then((doc) => {
                        // Handle different document structures
                        let text = '';
                        if (doc.body) {
                            text = doc.body.textContent || doc.body.innerText || '';
                        } else if (doc.documentElement) {
                            text = doc.documentElement.textContent || doc.documentElement.innerText || '';
                        } else if (doc.textContent) {
                            text = doc.textContent;
                        } else {
                            console.warn(`Unknown document structure for ${item.href}`, doc);
                        }

                        console.log(`Extracted ${text.length} chars from ${item.href}`);
                        item.unload();
                        return text;
                    }).catch(err => {
                        console.warn(`Failed to load section ${item.href}:`, err);
                        return '';
                    })
                );
            });

            const allTextSections = await Promise.all(textPromises);
            console.log(`Total sections: ${allTextSections.length}`);

            // Join all text
            const fullText = allTextSections.join('\n\n');
            console.log(`Total extracted: ${fullText.length} characters`);

            // Split into paragraphs (by double newlines or single newlines with meaningful content)
            const paragraphs = fullText
                .split(/\n\n+/)
                .map(p => p.replace(/\n/g, ' ').trim())
                .filter(p => p.length > 0);

            console.log(`Created ${paragraphs.length} paragraphs`);

            // Create HTML
            let html = '';
            paragraphs.forEach(para => {
                html += `<p>${this.escapeHtml(para)}</p>`;
            });

            if (html.length > 0) {
                container.innerHTML = html;
            } else {
                container.innerHTML = '<p>Could not extract text from this EPUB file.</p>';
            }

        } catch (error) {
            console.error('Error rendering EPUB:', error);
            container.innerHTML = `<p>Error loading EPUB: ${error.message}. Please try a different file.</p>`;
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    togglePlayPause() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    async play() {
        if (this.currentParagraphs.length === 0) return;
        if (this.isLoadingAudio) return;

        // Check authentication
        if (!ttsApi.isAuthenticated()) {
            try {
                await authManager.requireAuth();
                // Reload voices after authentication
                await this.loadVoices();
            } catch (error) {
                console.error('Authentication failed:', error);
                return;
            }
        }

        this.isPlaying = true;
        document.getElementById('play-pause').textContent = '⏸';

        const paragraph = this.currentParagraphs[this.currentParagraphIndex];
        await this.speak(paragraph.textContent);
    }

    pause() {
        this.isPlaying = false;
        document.getElementById('play-pause').textContent = '▶';

        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }
    }

    async speak(text) {
        if (this.isLoadingAudio) return;

        try {
            this.isLoadingAudio = true;

            // Highlight current paragraph
            this.highlightParagraph(this.currentParagraphIndex);

            // Get current settings from UI
            const voiceId = document.getElementById('voice-select').value;
            const speed = parseFloat(document.getElementById('speed-select').value);
            const pitch = parseFloat(document.getElementById('pitch-select').value);

            // Create cache key
            const cacheKey = `${voiceId}-${speed}-${pitch}-${text.substring(0, 50)}`;

            // Check cache
            let audioContent;
            if (this.audioCache.has(cacheKey)) {
                audioContent = this.audioCache.get(cacheKey);
            } else {
                // Synthesize speech
                const result = await ttsApi.synthesize(text, voiceId, speed, pitch);
                audioContent = result.audioContent;

                // Update usage tracking
                this.trackUsage(result.characterCount);

                // Cache the audio (limit cache size)
                if (this.audioCache.size > 20) {
                    const firstKey = this.audioCache.keys().next().value;
                    this.audioCache.delete(firstKey);
                }
                this.audioCache.set(cacheKey, audioContent);
            }

            // Stop current audio if any
            if (this.currentAudio) {
                this.currentAudio.pause();
            }

            // Create and play audio
            this.currentAudio = ttsApi.createAudioElement(audioContent);

            this.currentAudio.onended = () => {
                if (this.isPlaying) {
                    this.nextParagraph();
                }
            };

            this.currentAudio.onerror = (error) => {
                console.error('Audio playback error:', error);
                this.pause();
                alert('Error playing audio. Please try again.');
            };

            await this.currentAudio.play();

        } catch (error) {
            console.error('Speech synthesis error:', error);
            this.pause();
            alert(`Error: ${error.message || 'Failed to synthesize speech'}`);
        } finally {
            this.isLoadingAudio = false;
        }
    }

    previousParagraph() {
        if (this.currentParagraphIndex > 0) {
            this.currentParagraphIndex--;
            this.updateProgress();

            if (this.isPlaying) {
                this.speak(this.currentParagraphs[this.currentParagraphIndex].textContent);
            } else {
                this.highlightParagraph(this.currentParagraphIndex);
            }
        }
    }

    async nextParagraph() {
        if (this.currentParagraphIndex < this.currentParagraphs.length - 1) {
            this.currentParagraphIndex++;
            this.updateProgress();

            if (this.isPlaying) {
                await this.speak(this.currentParagraphs[this.currentParagraphIndex].textContent);
            } else {
                this.highlightParagraph(this.currentParagraphIndex);
            }
        } else {
            // End of book
            this.pause();
        }
    }

    jumpToParagraph(index) {
        this.currentParagraphIndex = index;
        this.updateProgress();

        if (this.isPlaying) {
            this.speak(this.currentParagraphs[this.currentParagraphIndex].textContent);
        } else {
            this.highlightParagraph(this.currentParagraphIndex);
        }
    }

    highlightParagraph(index) {
        this.currentParagraphs.forEach(p => p.classList.remove('active-paragraph'));

        if (this.currentParagraphs[index]) {
            const paragraph = this.currentParagraphs[index];
            paragraph.classList.add('active-paragraph');
            paragraph.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    updateProgress() {
        const progress = (this.currentParagraphIndex / (this.currentParagraphs.length - 1)) * 100;
        document.getElementById('progress-fill').style.width = `${progress}%`;
    }

    async saveReadingPosition() {
        await storage.saveReadingPosition(this.bookId, {
            paragraphIndex: this.currentParagraphIndex,
            totalParagraphs: this.currentParagraphs.length
        });
    }

    async loadReadingPosition() {
        // Try to get position from backend first using backend book ID
        if (ttsApi.isAuthenticated() && this.book.backendId) {
            try {
                const backendPosition = await ttsApi.getPosition(this.book.backendId);
                if (backendPosition && backendPosition.paragraphIndex !== undefined) {
                    this.currentParagraphIndex = Math.min(backendPosition.paragraphIndex, this.currentParagraphs.length - 1);
                    this.highlightParagraph(this.currentParagraphIndex);
                    this.updateProgress();
                    console.log(`✅ Loaded reading position from cloud: paragraph ${this.currentParagraphIndex}`);
                    return;
                }
            } catch (error) {
                console.error('Failed to load position from backend:', error);
            }
        }

        // Fallback to local position
        const position = storage.getReadingPosition(this.bookId);
        if (position && position.paragraphIndex !== undefined) {
            this.currentParagraphIndex = Math.min(position.paragraphIndex, this.currentParagraphs.length - 1);
            this.highlightParagraph(this.currentParagraphIndex);
            this.updateProgress();
        }
    }

    cycleFontSize() {
        const sizes = ['small', 'medium', 'large', 'x-large'];
        const current = document.body.getAttribute('data-font-size') || 'medium';
        const currentIndex = sizes.indexOf(current);
        const nextIndex = (currentIndex + 1) % sizes.length;
        const nextSize = sizes[nextIndex];

        document.body.setAttribute('data-font-size', nextSize);
        storage.saveSettings({ fontSize: nextSize });
    }

    cycleTheme() {
        const themes = ['light', 'sepia', 'dark'];
        const current = document.body.getAttribute('data-theme') || 'light';
        const currentIndex = themes.indexOf(current);
        const nextIndex = (currentIndex + 1) % themes.length;
        const nextTheme = themes[nextIndex];

        document.body.setAttribute('data-theme', nextTheme);
        storage.saveSettings({ theme: nextTheme });
    }

    trackUsage(characterCount) {
        const usage = storage.getUsage();
        const now = Date.now();
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

        // Reset if new month
        if (usage.monthStart < monthStart) {
            usage.charactersUsed = 0;
            usage.monthStart = monthStart;
        }

        usage.charactersUsed += characterCount;
        usage.lastUpdated = now;

        storage.saveUsage(usage);
        this.updateUsageDisplay();
    }

    updateUsageDisplay() {
        const usage = storage.getUsage();
        const usageEl = document.getElementById('usage-display');

        if (usageEl) {
            const percent = (usage.charactersUsed / 1000000) * 100;

            usageEl.textContent = `${usage.charactersUsed.toLocaleString()} / 1M chars (${percent.toFixed(1)}%)`;

            if (percent >= 90) {
                usageEl.style.color = '#dc2626';
            } else if (percent >= 75) {
                usageEl.style.color = '#f59e0b';
            } else {
                usageEl.style.color = '#6b7280';
            }
        }
    }
}

// Initialize reader
const reader = new BookReader();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => reader.init());
} else {
    reader.init();
}
