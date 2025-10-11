// Reader with EPUB.js Paginated Rendering and Google Cloud TTS
class BookReader {
    constructor() {
        this.bookId = null;
        this.book = null;
        this.rendition = null;
        this.epubBook = null;
        this.currentParagraphs = [];
        this.currentParagraphIndex = 0;
        this.isPlaying = false;
        this.currentAudio = null;
        this.voices = [];
        this.audioCache = new Map();
        this.isLoadingAudio = false;
        this.currentChunks = [];
        this.currentChunkIndex = 0;
        this.currentLocation = null;
    }

    async init() {
        // Require authentication to access reader
        if (!ttsApi.isAuthenticated()) {
            alert('Please login to read books.');
            window.location.href = 'index.html';
            return;
        }

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
        this.setupEventListeners();
        this.updateUsageDisplay();

        // Load voices if authenticated
        if (ttsApi.isAuthenticated()) {
            try {
                await this.loadVoices();
            } catch (error) {
                console.error('Failed to load voices:', error);
                document.getElementById('voice-select').innerHTML = '<option>Login to load voices</option>';
            }
        } else {
            document.getElementById('voice-select').innerHTML = '<option>Login to load voices</option>';
        }
    }

    setupUI() {
        const titleElement = document.getElementById('book-title');
        if (titleElement) {
            titleElement.textContent = this.book.title;
        }
    }

    setupEventListeners() {
        console.log('=== setupEventListeners called ===');
        // Back button
        const backBtn = document.getElementById('back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                await this.saveReadingPosition();
                window.location.href = 'index.html';
            });
        }

        // Sidebar opener button (in titlebar)
        this.sidebarOpen = false;
        const slider = document.getElementById('slider');
        const sidebar = document.getElementById('sidebar');
        const main = document.getElementById('main');

        if (slider && sidebar && main) {
            slider.addEventListener('click', (e) => {
                e.preventDefault();
                if (this.sidebarOpen) {
                    // Close sidebar
                    sidebar.classList.remove('open');
                    main.classList.add('closed');
                    this.sidebarOpen = false;
                } else {
                    // Open sidebar
                    sidebar.classList.add('open');
                    main.classList.remove('closed');
                    this.sidebarOpen = true;
                }
            });
        }

        // TOC view switcher (switches views within sidebar)
        const tocBtn = document.getElementById('show-Toc');
        const tocView = document.getElementById('tocView');

        if (tocBtn && tocView) {
            tocBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // Just ensure TOC view is visible (we only have TOC, no other views)
                tocView.style.display = 'block';
            });
        }

        // TTS Controls (removed from UI, keeping functions for future)

        // Speed control
        document.getElementById('speed-select').addEventListener('change', (e) => {
            const speed = parseFloat(e.target.value);
            storage.saveSettings({ speed });
            this.audioCache.clear();
        });

        // Pitch control
        document.getElementById('pitch-select').addEventListener('change', (e) => {
            const pitch = parseFloat(e.target.value);
            storage.saveSettings({ pitch });
            this.audioCache.clear();
        });

        // Voice control
        document.getElementById('voice-select').addEventListener('change', (e) => {
            storage.saveSettings({ voiceId: e.target.value });
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

        // Settings modal
        const settingBtn = document.getElementById('setting');
        const settingsModal = document.getElementById('settings-modal');
        const overlay = document.querySelector('.overlay');
        const closer = document.querySelector('.closer');

        if (settingBtn && settingsModal) {
            settingBtn.addEventListener('click', (e) => {
                e.preventDefault();
                settingsModal.classList.add('md-show');
                overlay.classList.add('md-show');
            });
        }

        if (closer) {
            closer.addEventListener('click', () => {
                settingsModal.classList.remove('md-show');
                overlay.classList.remove('md-show');
            });
        }

        if (overlay) {
            overlay.addEventListener('click', () => {
                settingsModal.classList.remove('md-show');
                overlay.classList.remove('md-show');
            });
        }

        // Navigation arrows (for EPUB)
        document.getElementById('prev').addEventListener('click', () => {
            if (this.rendition) {
                this.rendition.prev();
            }
        });

        document.getElementById('next').addEventListener('click', () => {
            if (this.rendition) {
                this.rendition.next();
            }
        });

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (!this.rendition) return;

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.rendition.prev();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.rendition.next();
            }
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

                const settings = storage.getSettings();
                if (settings.voiceId) {
                    voiceSelect.value = settings.voiceId;
                }
            }
        } catch (error) {
            console.error('Failed to load voices:', error);
            if (error.message.includes('login')) {
                document.getElementById('voice-select').innerHTML = '<option>Login to load voices</option>';
            } else {
                alert('Failed to load voices. Please check your internet connection and API configuration.');
            }
        }
    }

    loadSettings() {
        const settings = storage.getSettings();

        document.getElementById('speed-select').value = settings.speed || 1.0;
        document.getElementById('pitch-select').value = settings.pitch || 0;

        if (settings.voiceId) {
            document.getElementById('voice-select').value = settings.voiceId;
        }

        const fontSize = settings.fontSize || 'medium';
        document.body.setAttribute('data-font-size', fontSize);

        const theme = settings.theme || 'light';
        document.body.setAttribute('data-theme', theme);
    }

    async renderBook() {
        if (this.book.fileType === 'epub') {
            await this.renderEPUB();
        } else {
            await this.renderPDF();
        }
    }

    async renderEPUB() {
        try {
            const uint8Array = new Uint8Array(this.book.fileData);

            if (typeof ePub === 'undefined') {
                document.getElementById('viewer').innerHTML = '<p style="padding: 2rem;">EPUB library not loaded. Please refresh the page.</p>';
                return;
            }

            // Create EPUB book from array buffer
            this.epubBook = ePub(uint8Array.buffer);

            // Create paginated rendition
            this.rendition = this.epubBook.renderTo("viewer", {
                width: "100%",
                height: "100%",
                flow: "paginated",
                spread: "auto"  // Show two pages side by side
            });

            // Track location changes first
            this.rendition.on('relocated', (location) => {
                this.currentLocation = location.start.cfi;
                this.updatePageDisplay();
                this.saveReadingPosition();
            });

            // Display the book
            const displayed = await this.rendition.display();

            // Set initial location
            if (this.rendition.currentLocation()) {
                this.currentLocation = this.rendition.currentLocation().start.cfi;
            }

            // Apply theme
            this.applyTheme();

            // Generate locations for the whole book (for proper page tracking)
            this.epubBook.ready.then(() => {
                return this.epubBook.locations.generate(1600); // ~1 page per 1600 characters
            }).then((locations) => {
                console.log(`Generated ${locations.length} location points for entire book`);
                this.updatePageDisplay();
            }).catch((error) => {
                console.error('Failed to generate locations:', error);
            });

            // Load saved position
            await this.loadReadingPosition();

            // Load table of contents
            this.epubBook.loaded.navigation.then((navigation) => {
                this.loadTableOfContents(navigation.toc);
            }).catch((error) => {
                console.error('Failed to load navigation:', error);
            });

            console.log('EPUB rendered successfully');

        } catch (error) {
            console.error('Error rendering EPUB:', error);
            document.getElementById('area').innerHTML = `<p style="padding: 2rem;">Error loading EPUB: ${error.message}. Please try a different file.</p>`;
        }
    }

    async renderPDF() {
        try {
            const uint8Array = new Uint8Array(this.book.fileData);

            if (typeof pdfjsLib === 'undefined') {
                document.getElementById('area').innerHTML = '<p style="padding: 2rem;">PDF.js library not loaded. PDF reading is not available.</p>';
                return;
            }

            pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';

            const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
            const pdf = await loadingTask.promise;

            const container = document.getElementById('area');
            container.innerHTML = '<div class="pdf-text" style="padding: 2rem; overflow-y: auto; height: 100%;"></div>';
            const textContainer = container.querySelector('.pdf-text');

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const text = textContent.items.map(item => item.str).join(' ');

                const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
                paragraphs.forEach(para => {
                    const p = document.createElement('p');
                    p.textContent = para.trim();
                    p.style.marginBottom = '1.2rem';
                    p.style.cursor = 'pointer';
                    textContainer.appendChild(p);
                });
            }

            // Get paragraphs for TTS
            this.currentParagraphs = Array.from(textContainer.querySelectorAll('p'));
            this.currentParagraphs.forEach((p, index) => {
                p.addEventListener('click', () => {
                    this.jumpToParagraph(index);
                });
            });

            console.log('PDF rendered successfully');

        } catch (error) {
            console.error('Error rendering PDF:', error);
            document.getElementById('area').innerHTML = '<p style="padding: 2rem;">Error loading PDF. This might be a complex PDF that cannot be read as text.</p>';
        }
    }

    updatePageDisplay() {
        if (!this.rendition || !this.currentLocation) {
            return;
        }

        const location = this.rendition.currentLocation();

        if (location && location.start) {
            // Update chapter title if element exists
            const chapterTitle = document.getElementById('chapter-title');
            if (chapterTitle && location.start.displayed) {
                // This will show current chapter info
                // Could be enhanced to show actual chapter name from TOC
            }

            // Log page info to console since we removed the UI element
            if (this.epubBook.locations && this.epubBook.locations.total > 0) {
                const currentPage = this.epubBook.locations.locationFromCfi(this.currentLocation);
                const totalPages = this.epubBook.locations.total;
                console.log(`Page ${currentPage + 1} of ${totalPages}`);
            }
        }
    }

    applyTheme() {
        if (!this.rendition) return;

        const theme = document.body.getAttribute('data-theme') || 'light';

        const themes = {
            'light': {
                body: {
                    'background': '#ffffff',
                    'color': '#1f2937'
                }
            },
            'sepia': {
                body: {
                    'background': '#f4ecd8',
                    'color': '#5c4a3a'
                }
            },
            'dark': {
                body: {
                    'background': '#1f2937',
                    'color': '#e5e7eb'
                }
            }
        };

        this.rendition.themes.default(themes[theme]);

        // Apply font size
        const fontSize = document.body.getAttribute('data-font-size') || 'medium';
        const fontSizes = {
            'small': '14px',
            'medium': '16px',
            'large': '18px',
            'x-large': '20px'
        };

        this.rendition.themes.fontSize(fontSizes[fontSize]);
    }

    togglePlayPause() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    async play() {
        // TTS for PDF only for now
        if (this.book.fileType !== 'pdf' || this.currentParagraphs.length === 0) {
            alert('Text-to-speech is currently only available for PDF files.');
            return;
        }

        if (this.isLoadingAudio) return;

        if (!ttsApi.isAuthenticated()) {
            try {
                await authManager.requireAuth();
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

        this.currentChunks = [];
        this.currentChunkIndex = 0;
    }

    splitTextIntoChunks(text, maxChunkSize = 4500) {
        if (text.length <= maxChunkSize) {
            return [text];
        }

        const chunks = [];
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        let currentChunk = '';

        for (const sentence of sentences) {
            const trimmedSentence = sentence.trim();

            if (trimmedSentence.length > maxChunkSize) {
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }

                const words = trimmedSentence.split(' ');
                let wordChunk = '';

                for (const word of words) {
                    if ((wordChunk + ' ' + word).length > maxChunkSize) {
                        if (wordChunk) {
                            chunks.push(wordChunk.trim());
                        }
                        wordChunk = word;
                    } else {
                        wordChunk += (wordChunk ? ' ' : '') + word;
                    }
                }

                if (wordChunk) {
                    currentChunk = wordChunk;
                }
            } else if ((currentChunk + ' ' + trimmedSentence).length > maxChunkSize) {
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                }
                currentChunk = trimmedSentence;
            } else {
                currentChunk += (currentChunk ? ' ' : '') + trimmedSentence;
            }
        }

        if (currentChunk) {
            chunks.push(currentChunk.trim());
        }

        return chunks.length > 0 ? chunks : [text];
    }

    async speak(text, isNewParagraph = true) {
        if (this.isLoadingAudio) return;

        try {
            this.isLoadingAudio = true;
            this.highlightParagraph(this.currentParagraphIndex);

            if (isNewParagraph) {
                this.currentChunks = this.splitTextIntoChunks(text);
                this.currentChunkIndex = 0;
            }

            const chunk = this.currentChunks[this.currentChunkIndex];
            const voiceId = document.getElementById('voice-select').value;
            const speed = parseFloat(document.getElementById('speed-select').value);
            const pitch = parseFloat(document.getElementById('pitch-select').value);

            const cacheKey = `${voiceId}-${speed}-${pitch}-${chunk.substring(0, 50)}`;

            let audioContent;
            if (this.audioCache.has(cacheKey)) {
                audioContent = this.audioCache.get(cacheKey);
            } else {
                const result = await ttsApi.synthesize(chunk, voiceId, speed, pitch);
                audioContent = result.audioContent;

                this.trackUsage(result.characterCount);

                if (this.audioCache.size > 20) {
                    const firstKey = this.audioCache.keys().next().value;
                    this.audioCache.delete(firstKey);
                }
                this.audioCache.set(cacheKey, audioContent);
            }

            if (this.currentAudio) {
                this.currentAudio.pause();
            }

            this.currentAudio = ttsApi.createAudioElement(audioContent);

            this.currentAudio.onended = () => {
                if (this.isPlaying) {
                    if (this.currentChunkIndex < this.currentChunks.length - 1) {
                        this.currentChunkIndex++;
                        this.speak(text, false);
                    } else {
                        this.nextParagraph();
                    }
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

            if (this.isPlaying) {
                await this.speak(this.currentParagraphs[this.currentParagraphIndex].textContent);
            } else {
                this.highlightParagraph(this.currentParagraphIndex);
            }
        } else {
            this.pause();
        }
    }

    jumpToParagraph(index) {
        this.currentParagraphIndex = index;

        if (this.isPlaying) {
            this.speak(this.currentParagraphs[this.currentParagraphIndex].textContent);
        } else {
            this.highlightParagraph(this.currentParagraphIndex);
        }
    }

    highlightParagraph(index) {
        if (this.currentParagraphs.length === 0) return;

        this.currentParagraphs.forEach(p => p.classList.remove('active-paragraph'));

        if (this.currentParagraphs[index]) {
            const paragraph = this.currentParagraphs[index];
            paragraph.classList.add('active-paragraph');
            paragraph.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    async saveReadingPosition() {
        if (this.book.fileType === 'epub' && this.currentLocation) {
            await storage.saveReadingPosition(this.bookId, {
                cfi: this.currentLocation,
                type: 'epub'
            });
        } else if (this.book.fileType === 'pdf') {
            await storage.saveReadingPosition(this.bookId, {
                paragraphIndex: this.currentParagraphIndex,
                totalParagraphs: this.currentParagraphs.length,
                type: 'pdf'
            });
        }
    }

    async loadReadingPosition() {
        const position = storage.getReadingPosition(this.bookId);

        if (position && position.type === 'epub' && position.cfi && this.rendition) {
            try {
                await this.rendition.display(position.cfi);
                console.log('Loaded EPUB position:', position.cfi);
            } catch (error) {
                console.error('Failed to load position:', error);
            }
        } else if (position && position.type === 'pdf' && position.paragraphIndex !== undefined) {
            this.currentParagraphIndex = Math.min(position.paragraphIndex, this.currentParagraphs.length - 1);
            this.highlightParagraph(this.currentParagraphIndex);
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

        // Apply to EPUB rendition
        this.applyTheme();
    }

    cycleTheme() {
        const themes = ['light', 'sepia', 'dark'];
        const current = document.body.getAttribute('data-theme') || 'light';
        const currentIndex = themes.indexOf(current);
        const nextIndex = (currentIndex + 1) % themes.length;
        const nextTheme = themes[nextIndex];

        document.body.setAttribute('data-theme', nextTheme);
        storage.saveSettings({ theme: nextTheme });

        // Apply to EPUB rendition
        this.applyTheme();
    }

    trackUsage(characterCount) {
        const usage = storage.getUsage();
        const now = Date.now();
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

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

    loadTableOfContents(toc) {
        const tocView = document.getElementById('tocView');
        if (!tocView) return;

        if (!toc || toc.length === 0) {
            tocView.innerHTML = '<p>No chapters available</p>';
            return;
        }

        // Recursively render TOC items
        const renderTOCItems = (items, level = 0) => {
            return items.map(item => {
                const label = this.escapeHtml(item.label);
                let html = `<a href="#" class="toc_link" data-href="${item.href}">${label}</a>`;

                // Add sub-items if they exist
                if (item.subitems && item.subitems.length > 0) {
                    html += '<ol>' + renderTOCItems(item.subitems, level + 1) + '</ol>';
                }

                return '<li>' + html + '</li>';
            }).join('');
        };

        tocView.innerHTML = '<ol>' + renderTOCItems(toc) + '</ol>';

        // Add click handlers to all TOC items
        tocView.querySelectorAll('.toc_link').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const href = e.target.dataset.href;
                if (href && this.rendition) {
                    this.rendition.display(href);
                }
            });
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize reader
const reader = new BookReader();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => reader.init());
} else {
    reader.init();
}
