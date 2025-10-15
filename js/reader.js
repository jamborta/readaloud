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
        this.currentHighlightElement = null;
        this.savePositionTimeout = null;
        this.pageAdvanceFailures = 0;
        this.lastExtractedText = null;
        this.lastSectionIndex = null;
        this.chunkAudioCache = new Map(); // chunkId -> audioUrl
        this.currentChapterIndex = null;
        this.isGeneratingChapterAudio = false;
        this.chapterChunks = []; // All chunks for entire chapter (deterministic)
        this.currentChapterChunkIndex = -1; // Which chapter chunk is currently playing
        this.textExtractionPromise = Promise.resolve(); // Resolves when text extraction completes
        this.textExtractionResolver = null; // Resolver for current extraction
        this.isLoadingInitialPosition = false; // Prevent auto-save during initial load
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
            }
        }
    }

    setupUI() {
        const titleElement = document.getElementById('book-title');
        if (titleElement) {
            titleElement.textContent = this.book.title;
        }
    }

    setupEventListeners() {
        // Sidebar toggle - simple!
        const slider = document.getElementById('slider');
        const sidebar = document.getElementById('sidebar');

        if (slider && sidebar) {
            slider.addEventListener('click', (e) => {
                e.preventDefault();
                sidebar.classList.toggle('open');
            });
        }

        // Close book button
        const closeBook = document.getElementById('close-book');
        if (closeBook) {
            closeBook.addEventListener('click', async (e) => {
                e.preventDefault();
                await this.saveReadingPosition();
                window.location.href = 'index.html';
            });
        }

        // TTS Controls
        const ttsControls = document.getElementById('tts-controls');
        if (ttsControls) {
            ttsControls.style.display = 'flex';

            document.getElementById('play-pause').addEventListener('click', () => {
                this.togglePlayPause();
            });

            document.getElementById('prev-paragraph').addEventListener('click', () => {
                this.previousParagraph();
            });

            document.getElementById('next-paragraph').addEventListener('click', () => {
                this.nextParagraph();
            });

            document.getElementById('generate-chapter').addEventListener('click', () => {
                this.generateCurrentChapterAudio();
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
            console.log('Voices loaded:', this.voices.length);
        } catch (error) {
            console.error('Failed to load voices:', error);
        }
    }

    loadSettings() {
        const settings = storage.getSettings();

        // Apply theme and font size to the reader
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
            this.rendition.on('relocated', async (location) => {
                this.currentLocation = location.start.cfi;
                this.updatePageDisplay();

                // Debounce position saving - only save after 3 seconds of no page changes
                // Don't save during active playback (will save when stopped)
                // Don't save during initial position load (prevents overwriting saved position)
                if (this.savePositionTimeout) {
                    clearTimeout(this.savePositionTimeout);
                }

                if (!this.isPlaying && !this.isLoadingInitialPosition) {
                    this.savePositionTimeout = setTimeout(() => {
                        this.saveReadingPosition();
                    }, 3000);
                }

                // Clear old highlight when page changes
                this.removeHighlight();

                // Extract text for TTS when page changes - pass location to avoid stale data
                await this.extractCurrentPageText(location);
            });

            // Display the book at beginning (will be overridden by loadReadingPosition if position exists)
            console.log('📂 Opening book at beginning...');
            const displayed = await this.rendition.display();

            // Set initial location
            if (this.rendition.currentLocation()) {
                this.currentLocation = this.rendition.currentLocation().start.cfi;
                console.log('📍 Initial CFI:', this.currentLocation);
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

            // Load saved position (will jump to saved position if it exists)
            console.log('🔍 Loading saved reading position...');
            await this.loadReadingPosition();
            console.log('✅ Position load complete');

            // Load table of contents
            this.epubBook.loaded.navigation.then((navigation) => {
                this.loadTableOfContents(navigation.toc);
            }).catch((error) => {
                console.error('Failed to load navigation:', error);
            });

            // Note: Initial text extraction happens via the 'relocated' event
            // No need for setTimeout - the relocated event fires after display()

            console.log('EPUB rendered successfully');

        } catch (error) {
            console.error('Error rendering EPUB:', error);
            document.getElementById('area').innerHTML = `<p style="padding: 2rem;">Error loading EPUB: ${error.message}. Please try a different file.</p>`;
        }
    }

    async extractCurrentPageText(providedLocation = null) {
        // Create a new Promise for this extraction
        this.textExtractionPromise = new Promise((resolve) => {
            this.textExtractionResolver = resolve;
        });

        try {
            if (!this.rendition || !this.epubBook) {
                console.error('❌ Rendition or book not ready');
                this.textExtractionResolver();
                return;
            }

            // Use provided location if available, otherwise query current location
            const location = providedLocation || this.rendition.currentLocation();
            if (!location || !location.start || !location.end) {
                console.error('❌ No location available');
                this.textExtractionResolver();
                return;
            }

            console.log('📍 Extracting text from current page...');

            try {
                // Check if we moved to a different chapter - clear chunk audio cache if so
                const newChapterIndex = location.start.index;
                if (this.currentChapterIndex !== null && this.currentChapterIndex !== newChapterIndex) {
                    console.log(`Moved from chapter ${this.currentChapterIndex} to ${newChapterIndex}, clearing audio cache`);
                    this.chunkAudioCache.clear();
                    this.chapterChunks = [];
                    this.currentChapterChunkIndex = -1;

                    // Reset button icon
                    const btn = document.getElementById('generate-chapter');
                    if (btn) {
                        btn.textContent = 'Gen';
                        btn.title = 'Generate chapter audio';
                    }
                }

                console.log('🔍 CFI DEBUG (initial location):');
                console.log('  Start CFI:', location.start.cfi);
                console.log('  End CFI:', location.end.cfi);
                console.log('  Start index:', location.start.index);
                console.log('  End index:', location.end.index);

                // Retry getRange() with fresh location queries
                // The CFI can change as the page stabilizes
                let range = null;
                let attempts = 0;
                const MAX_ATTEMPTS = 10;
                let lastCfi = null;

                while (!range && attempts < MAX_ATTEMPTS) {
                    attempts++;

                    // Re-query location to get fresh, stable CFI
                    const freshLocation = this.rendition.currentLocation();
                    if (!freshLocation || !freshLocation.start || !freshLocation.end) {
                        console.log(`⚠️ No location available, attempt ${attempts}/${MAX_ATTEMPTS}, retrying...`);
                        await new Promise(resolve => setTimeout(resolve, 100));
                        continue;
                    }

                    const freshStartCfi = freshLocation.start.cfi;
                    const freshEndCfi = freshLocation.end.cfi;
                    const freshRangeCfi = this.makeRangeCfi(freshStartCfi, freshEndCfi);

                    // Log if CFI changed
                    if (lastCfi !== freshRangeCfi) {
                        console.log(`🔄 CFI updated on attempt ${attempts}:`, freshRangeCfi);
                        lastCfi = freshRangeCfi;
                    }

                    range = await this.epubBook.getRange(freshRangeCfi);

                    if (!range) {
                        console.log(`⚠️ getRange() returned null, attempt ${attempts}/${MAX_ATTEMPTS}, retrying...`);
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }

                if (!range) {
                    console.warn('❌ getRange() returned null after all retries');
                    console.warn('  This usually means:');
                    console.warn('  1. CFI is invalid or malformed');
                    console.warn('  2. Page spans multiple chapter sections');
                    console.warn('  3. DOM elements referenced by CFI do not exist');
                    console.warn('  Last attempted CFI:', lastCfi);

                    // TODO: Try fallback extraction from iframe DOM
                    this.currentParagraphs = [];
                    if (this.textExtractionResolver) {
                        this.textExtractionResolver();
                    }
                    return;
                }

                console.log(`✅ getRange() succeeded on attempt ${attempts}/${MAX_ATTEMPTS}`);
                if (attempts > 1) {
                    console.log('  CFI stabilized after initial failures');
                }

                const visibleText = range.toString();

                if (visibleText.length === 0) {
                    console.warn('⚠️ Range returned empty text');
                    this.currentParagraphs = [];
                    if (this.textExtractionResolver) {
                        this.textExtractionResolver();
                    }
                    return;
                }

                console.log(`✅ Got ${visibleText.length} characters from CFI range`);

                // Use range.cloneContents() to get ONLY visible page content
                const fragment = range.cloneContents();

                // Helper function to recursively extract all text from the fragment
                function getTextNodesFromFragment(node) {
                    const textNodes = [];

                    function walk(n) {
                        if (n.nodeType === Node.TEXT_NODE) {
                            const text = n.textContent.replace(/\s+/g, ' ').trim();
                            if (text.length >= 5) { // MIN_CHUNK_SIZE
                                textNodes.push(text);
                            }
                        } else if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                            // Walk children for both elements and document fragments
                            for (let child of n.childNodes) {
                                walk(child);
                            }
                        }
                    }

                    walk(node);
                    return textNodes;
                }

                const textNodes = getTextNodesFromFragment(fragment);

                // Now chunk the text
                const paragraphData = [];
                const MAX_CHUNK_SIZE = 300;
                const MIN_CHUNK_SIZE = 5;

                for (let i = 0; i < textNodes.length; i++) {
                    const nodeText = textNodes[i];

                    // If text is small enough, make it one chunk
                    if (nodeText.length <= MAX_CHUNK_SIZE) {
                        paragraphData.push({
                            textContent: nodeText
                        });
                    } else {
                        // Split large text into sentence-based chunks
                        const sentences = nodeText.split(/(?<=[.!?])\s+/);
                        let currentChunk = '';

                        sentences.forEach((sentence) => {
                            const trimmed = sentence.trim();
                            if (!trimmed) return;

                            if (currentChunk.length > 0 && (currentChunk.length + trimmed.length + 1) > MAX_CHUNK_SIZE) {
                                if (currentChunk.length >= MIN_CHUNK_SIZE) {
                                    paragraphData.push({
                                        textContent: currentChunk
                                    });
                                }
                                currentChunk = trimmed;
                            } else {
                                currentChunk += (currentChunk ? ' ' : '') + trimmed;
                            }
                        });

                        // Save last chunk
                        if (currentChunk.length >= MIN_CHUNK_SIZE) {
                            paragraphData.push({
                                textContent: currentChunk
                            });
                        }
                    }
                }

                this.currentParagraphs = paragraphData;
                this.currentParagraphIndex = 0;

                // Track for loop detection
                const firstParagraphText = paragraphData.length > 0 ? paragraphData[0].textContent : null;
                this.lastExtractedText = firstParagraphText;
                this.lastSectionIndex = location.start.index;

                console.log(`✅ Extracted ${this.currentParagraphs.length} paragraphs from current page`);

                // Load chapter chunks deterministically if moving to new chapter
                if (this.currentChapterIndex !== newChapterIndex) {
                    console.log(`📖 Loading chapter chunks for chapter ${newChapterIndex}...`);
                    this.chapterChunks = await this.loadChapterChunks(newChapterIndex);
                    this.currentChapterIndex = newChapterIndex;
                }

                // Check if first chunk has audio (lightweight check)
                await this.checkForExistingChapterAudio(newChapterIndex);

                // Resolve the text extraction Promise
                if (this.textExtractionResolver) {
                    this.textExtractionResolver();
                }

            } catch (error) {
                console.error('❌ CFI extraction failed:', error);
                this.currentParagraphs = [];
                // Resolve even on error
                if (this.textExtractionResolver) {
                    this.textExtractionResolver();
                }
            }

        } catch (error) {
            console.error('❌ CRITICAL ERROR in extractCurrentPageText:', error);
            this.currentParagraphs = [];
            // Resolve even on error
            if (this.textExtractionResolver) {
                this.textExtractionResolver();
            }
        }
    }

    async loadChapterChunks(chapterIndex) {
        /**
         * Load and chunk entire chapter deterministically
         * This creates device-independent chunks tied to chapter content only
         */
        try {
            const section = this.epubBook.spine.get(chapterIndex);
            if (!section) {
                console.error('Could not load chapter section');
                return [];
            }

            // Load the section content ONLY if not already loaded
            // This prevents potential re-rendering on mobile devices
            if (!section.document) {
                await section.load(this.epubBook.load.bind(this.epubBook));
            }
            const sectionDoc = section.document;

            if (!sectionDoc || !sectionDoc.body) {
                console.error('Could not read chapter content');
                return [];
            }

            // Extract all text from the chapter
            const allText = sectionDoc.body.textContent.replace(/\s+/g, ' ').trim();

            // Chunk the text deterministically
            const chunks = [];
            const MAX_CHUNK_SIZE = 300;
            const MIN_CHUNK_SIZE = 5;

            const sentences = allText.split(/(?<=[.!?])\s+/);
            let currentChunk = '';

            sentences.forEach((sentence) => {
                const trimmed = sentence.trim();
                if (!trimmed) return;

                if (currentChunk.length > 0 && (currentChunk.length + trimmed.length + 1) > MAX_CHUNK_SIZE) {
                    if (currentChunk.length >= MIN_CHUNK_SIZE) {
                        chunks.push(currentChunk);
                    }
                    currentChunk = trimmed;
                } else {
                    currentChunk += (currentChunk ? ' ' : '') + trimmed;
                }
            });

            // Save last chunk
            if (currentChunk.length >= MIN_CHUNK_SIZE) {
                chunks.push(currentChunk);
            }

            console.log(`📚 Loaded ${chunks.length} deterministic chunks for chapter ${chapterIndex}`);
            return chunks;

        } catch (error) {
            console.error('Failed to load chapter chunks:', error);
            return [];
        }
    }

    makeRangeCfi(a, b) {
        const CFI = new ePub.CFI();
        const start = CFI.parse(a);
        const end = CFI.parse(b);

        const cfi = {
            range: true,
            base: start.base,
            path: {
                steps: [],
                terminal: null
            },
            start: start.path,
            end: end.path
        };

        const len = cfi.start.steps.length;
        for (let i = 0; i < len; i++) {
            if (CFI.equalStep(cfi.start.steps[i], cfi.end.steps[i])) {
                if (i == len - 1) {
                    if (cfi.start.terminal === cfi.end.terminal) {
                        cfi.path.steps.push(cfi.start.steps[i]);
                        cfi.range = false;
                    }
                } else {
                    cfi.path.steps.push(cfi.start.steps[i]);
                }
            } else break;
        }

        cfi.start.steps = cfi.start.steps.slice(cfi.path.steps.length);
        cfi.end.steps = cfi.end.steps.slice(cfi.path.steps.length);

        return 'epubcfi(' + CFI.segmentString(cfi.base) + '!' +
            CFI.segmentString(cfi.path) + ',' +
            CFI.segmentString(cfi.start) + ',' +
            CFI.segmentString(cfi.end) + ')';
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
        // Reset failure counter when starting playback
        this.pageAdvanceFailures = 0;

        // Try to extract text if we don't have any
        if (this.currentParagraphs.length === 0) {
            console.log('No paragraphs loaded, attempting extraction...');

            // Wait a bit for the book to be fully ready
            await new Promise(resolve => setTimeout(resolve, 300));
            await this.extractCurrentPageText();

            // Still no paragraphs? Try one more time after a longer delay
            if (this.currentParagraphs.length === 0) {
                console.log('First extraction failed, trying again...');
                await new Promise(resolve => setTimeout(resolve, 700));
                await this.extractCurrentPageText();
            }

            // Still no paragraphs? Stop.
            if (this.currentParagraphs.length === 0) {
                console.error('Could not extract any text from the current page');
                alert('Could not extract text from this page. Please try navigating to a different page or wait a moment and try again.');
                return;
            }
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
        const playPauseBtn = document.getElementById('play-pause');
        if (playPauseBtn) {
            playPauseBtn.textContent = '⏸';
        }

        const paragraph = this.currentParagraphs[this.currentParagraphIndex];
        const text = paragraph.textContent || paragraph;
        await this.speak(text);
    }

    pause() {
        this.isPlaying = false;
        const playPauseBtn = document.getElementById('play-pause');
        if (playPauseBtn) {
            playPauseBtn.textContent = '▶';
        }

        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }

        this.currentChunks = [];
        this.currentChunkIndex = 0;
        this.currentChapterChunkIndex = -1; // Reset chapter chunk tracking

        // Save position when pausing
        this.saveReadingPosition();
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

            // Check if we have pre-generated chapter audio
            const location = this.rendition ? this.rendition.currentLocation() : null;
            const currentChapterIndex = location && location.start ? location.start.index : null;

            if (this.currentChapterIndex === currentChapterIndex && this.chapterChunks.length > 0) {
                // Map current paragraph to chapter chunk
                const paragraph = this.currentParagraphs[this.currentParagraphIndex];
                const paragraphText = (paragraph.textContent || paragraph).replace(/\s+/g, ' ').trim();

                // Find matching chapter chunk by text content
                let chapterChunkIndex = -1;
                const searchText = paragraphText.substring(0, 100);

                for (let i = 0; i < this.chapterChunks.length; i++) {
                    const normalizedChunk = this.chapterChunks[i].replace(/\s+/g, ' ').trim();
                    if (normalizedChunk.includes(searchText) || searchText.includes(normalizedChunk.substring(0, 100))) {
                        chapterChunkIndex = i;
                        break;
                    }
                }

                if (chapterChunkIndex >= 0) {
                    console.log(`📍 Mapped paragraph ${this.currentParagraphIndex} to chapter chunk ${chapterChunkIndex}`);

                    // Check if audio URL is cached
                    if (!this.chunkAudioCache.has(chapterChunkIndex)) {
                        // Lazy load audio URL from backend
                        try {
                            const result = await ttsApi.getChunkAudio(
                                this.book.backendId,
                                currentChapterIndex,
                                chapterChunkIndex
                            );

                            if (result && result.audioUrl) {
                                console.log(`🔗 Loaded audio URL for chunk ${chapterChunkIndex}`);
                                this.chunkAudioCache.set(chapterChunkIndex, result.audioUrl);
                            } else {
                                throw new Error('Audio not found');
                            }
                        } catch (error) {
                            console.log(`⚠️ No pre-generated audio for chunk ${chapterChunkIndex}, using on-demand TTS`);
                            await this.speakWithOnDemandTTS(text, isNewParagraph);
                            return;
                        }
                    }

                    // Store which chapter chunk we're playing
                    this.currentChapterChunkIndex = chapterChunkIndex;

                    // Play cached audio
                    const audioUrl = this.chunkAudioCache.get(chapterChunkIndex);
                    console.log(`🔊 Playing cached audio for chunk ${chapterChunkIndex}`);

                    // Stop current audio if playing
                    if (this.currentAudio) {
                        this.currentAudio.pause();
                    }

                    // Load chunk audio
                    this.currentAudio = new Audio(audioUrl);

                    this.currentAudio.onerror = (error) => {
                        console.error('Chunk audio playback error:', error);
                        this.pause();
                        alert('Error playing chunk audio. Try regenerating.');
                    };

                    // Set up ended handler to move to next chapter chunk
                    this.currentAudio.onended = () => {
                        if (this.isPlaying) {
                            // CRITICAL: For mobile browsers, we must call play() SYNCHRONOUSLY
                            // in the onended handler without any awaits/async in between
                            this.playNextChapterChunkSync();
                        }
                    };

                    try {
                        await this.currentAudio.play();
                    } catch (error) {
                        console.error('Playback error:', error.message);
                        throw new Error(`Cannot play audio: ${error.message}`);
                    }
                    return;
                }
            }

            // Fall back to on-demand TTS
            await this.speakWithOnDemandTTS(text, isNewParagraph);

        } catch (error) {
            console.error('Speech synthesis error:', error);
            this.pause();
            alert(`Error: ${error.message || 'Failed to synthesize speech'}`);
        } finally {
            this.isLoadingAudio = false;
        }
    }

    playNextChapterChunkSync() {
        /**
         * CRITICAL: Synchronous method to play next chunk
         * This is called from onended handler and MUST call play() synchronously
         * to avoid mobile browser blocking
         */
        if (this.currentChapterChunkIndex < 0 || this.chapterChunks.length === 0) {
            console.error('Invalid state for sync playback');
            return;
        }

        // Move to next chunk
        const nextChunkIndex = this.currentChapterChunkIndex + 1;

        if (nextChunkIndex >= this.chapterChunks.length) {
            console.log('Reached end of chapter chunks');
            this.pause();
            return;
        }

        // Check if we have audio URL cached for next chunk
        if (!this.chunkAudioCache.has(nextChunkIndex)) {
            console.log(`⚠️ No cached audio for chunk ${nextChunkIndex}, stopping playback`);
            this.pause();
            return;
        }

        // Update index
        this.currentChapterChunkIndex = nextChunkIndex;

        // Get audio URL synchronously from cache
        const audioUrl = this.chunkAudioCache.get(nextChunkIndex);
        console.log(`🔊 Playing chunk ${nextChunkIndex} synchronously`);

        // Stop current audio
        if (this.currentAudio) {
            this.currentAudio.pause();
        }

        // Create and play new audio SYNCHRONOUSLY
        this.currentAudio = new Audio(audioUrl);

        this.currentAudio.onerror = (error) => {
            console.error('Chunk audio playback error:', error);
            this.pause();
        };

        // Set up ended handler for next chunk (recursive)
        this.currentAudio.onended = () => {
            if (this.isPlaying) {
                this.playNextChapterChunkSync();
            }
        };

        // SYNCHRONOUS play() call - no await!
        this.currentAudio.play().catch(error => {
            console.error('Failed to play chunk:', error);
            this.pause();
        });

        // Update paragraph index if chunk is on current page (async, but doesn't block audio)
        this.updateParagraphIndexForChunk(nextChunkIndex);
    }

    async updateParagraphIndexForChunk(chunkIndex) {
        /**
         * Update paragraph index and highlighting for the given chunk
         * This runs async after audio starts playing
         */
        const chunkText = this.chapterChunks[chunkIndex];
        const searchText = chunkText.substring(0, 100).replace(/\s+/g, ' ').trim();

        // Find chunk on current page
        for (let i = 0; i < this.currentParagraphs.length; i++) {
            const para = this.currentParagraphs[i];
            const paraText = (para.textContent || para).replace(/\s+/g, ' ').trim();

            if (paraText.includes(searchText) || searchText.includes(paraText.substring(0, 100))) {
                this.currentParagraphIndex = i;
                this.highlightParagraph(i);
                return;
            }
        }

        // Not on current page - need to turn page
        console.log(`📄 Chunk ${chunkIndex} not on current page`);

        if (this.book.fileType === 'epub' && this.rendition) {
            const moved = this.rendition.next();
            if (moved) {
                // Wait for page to load
                const oldPromise = this.textExtractionPromise;
                while (this.textExtractionPromise === oldPromise) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                await this.textExtractionPromise;

                // Try to find chunk on new page
                for (let i = 0; i < this.currentParagraphs.length; i++) {
                    const para = this.currentParagraphs[i];
                    const paraText = (para.textContent || para).replace(/\s+/g, ' ').trim();

                    if (paraText.includes(searchText) || searchText.includes(paraText.substring(0, 100))) {
                        this.currentParagraphIndex = i;
                        this.highlightParagraph(i);
                        return;
                    }
                }
            }
        }
    }

    async nextChapterChunk() {
        /**
         * Move to next chapter chunk (used when playing pre-generated audio)
         * This handles chunks that span multiple pages
         */
        if (this.currentChapterChunkIndex < 0 || this.chapterChunks.length === 0) {
            // Fall back to regular paragraph navigation
            this.nextParagraph();
            return;
        }

        // Move to next chunk
        this.currentChapterChunkIndex++;

        if (this.currentChapterChunkIndex >= this.chapterChunks.length) {
            // Reached end of chapter
            console.log('Reached end of chapter chunks');
            this.pause();
            return;
        }

        const nextChunkText = this.chapterChunks[this.currentChapterChunkIndex];
        const searchText = nextChunkText.substring(0, 100).replace(/\s+/g, ' ').trim();

        console.log(`➡️ Moving to next chapter chunk ${this.currentChapterChunkIndex}`);

        // Check if next chunk is on current page
        let foundOnCurrentPage = false;
        for (let i = 0; i < this.currentParagraphs.length; i++) {
            const para = this.currentParagraphs[i];
            const paraText = (para.textContent || para).replace(/\s+/g, ' ').trim();

            if (paraText.includes(searchText) || searchText.includes(paraText.substring(0, 100))) {
                // Found on current page!
                console.log(`✅ Next chunk found on current page at paragraph ${i}`);
                this.currentParagraphIndex = i;
                foundOnCurrentPage = true;
                break;
            }
        }

        if (foundOnCurrentPage) {
            // Play the chunk
            const paragraph = this.currentParagraphs[this.currentParagraphIndex];
            const text = paragraph.textContent || paragraph;
            await this.speak(text);
        } else {
            // Chunk is on next page, turn the page
            console.log(`📄 Next chunk is on next page, turning page...`);

            if (this.book.fileType === 'epub' && this.rendition) {
                const moved = this.rendition.next();

                if (!moved) {
                    console.log('Reached end of book');
                    this.pause();
                    return;
                }

                // Wait for NEW text extraction (not the old one)
                const oldChunkPromise = this.textExtractionPromise;
                console.log(`⏳ Waiting for new page to load...`);

                // Wait until the relocated event fires and creates a new Promise
                while (this.textExtractionPromise === oldChunkPromise) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                // Now wait for the new extraction to complete
                await this.textExtractionPromise;
                console.log(`✅ Text extraction completed`);

                // Find the chunk in new page
                for (let i = 0; i < this.currentParagraphs.length; i++) {
                    const para = this.currentParagraphs[i];
                    const paraText = (para.textContent || para).replace(/\s+/g, ' ').trim();

                    if (paraText.includes(searchText) || searchText.includes(paraText.substring(0, 100))) {
                        console.log(`✅ Found chunk on new page at paragraph ${i}`);
                        this.currentParagraphIndex = i;
                        const text = para.textContent || para;
                        await this.speak(text);
                        return;
                    }
                }

                // If we didn't find it, just play from start of page
                console.log(`⚠️ Could not find chunk on new page, playing from start`);
                this.currentParagraphIndex = 0;
                if (this.currentParagraphs.length > 0) {
                    const para = this.currentParagraphs[0];
                    const text = para.textContent || para;
                    await this.speak(text);
                } else {
                    this.pause();
                }
            } else {
                // Not EPUB or can't advance
                this.pause();
            }
        }
    }

    async speakWithOnDemandTTS(text, isNewParagraph = true) {
        // On-demand TTS with mobile-safe synchronous playback
        // Reset chapter chunk tracking when using on-demand TTS
        this.currentChapterChunkIndex = -1;

        if (isNewParagraph) {
            this.currentChunks = this.splitTextIntoChunks(text);
            this.currentChunkIndex = 0;
        }

        const chunk = this.currentChunks[this.currentChunkIndex];
        const settings = storage.getSettings();
        const voiceId = settings.voiceId || 'en-US-Standard-A';
        const speed = settings.speed || 1.0;
        const pitch = settings.pitch || 0;

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

        // CRITICAL: Use synchronous onended handler for mobile browser compatibility
        this.currentAudio.onended = () => {
            if (this.isPlaying) {
                if (this.currentChunkIndex < this.currentChunks.length - 1) {
                    // More chunks in current paragraph - play next chunk synchronously
                    this.currentChunkIndex++;
                    this.playNextOnDemandChunkSync(text);
                } else {
                    // Move to next paragraph asynchronously (not chained from audio)
                    this.nextParagraph();
                }
            }
        };

        this.currentAudio.onerror = (error) => {
            console.error('Audio playback error:', error);
            this.pause();
            alert('Error playing audio. Please try again.');
        };

        // Use .catch() pattern instead of await to maintain initial sync for first chunk
        try {
            await this.currentAudio.play();
        } catch (error) {
            console.error('Playback error:', error.message);
            throw error;
        }
    }

    playNextOnDemandChunkSync(text) {
        /**
         * CRITICAL: Synchronous method to play next on-demand TTS chunk
         * This is called from onended handler and MUST call play() synchronously
         * to avoid mobile browser blocking
         */
        if (this.currentChunkIndex < 0 || this.currentChunks.length === 0) {
            console.error('Invalid state for on-demand sync playback');
            return;
        }

        const chunk = this.currentChunks[this.currentChunkIndex];
        const settings = storage.getSettings();
        const voiceId = settings.voiceId || 'en-US-Standard-A';
        const speed = settings.speed || 1.0;
        const pitch = settings.pitch || 0;

        const cacheKey = `${voiceId}-${speed}-${pitch}-${chunk.substring(0, 50)}`;

        // Check if cached
        if (!this.audioCache.has(cacheKey)) {
            // Not cached - need to synthesize (this breaks sync chain, but unavoidable)
            console.log(`⚠️ Chunk ${this.currentChunkIndex} not cached, need async synthesis`);
            // Fall back to async speak
            this.speak(text, false);
            return;
        }

        // Get from cache synchronously
        const audioContent = this.audioCache.get(cacheKey);

        // Stop current audio
        if (this.currentAudio) {
            this.currentAudio.pause();
        }

        // Create and play new audio SYNCHRONOUSLY
        this.currentAudio = ttsApi.createAudioElement(audioContent);

        this.currentAudio.onerror = (error) => {
            console.error('On-demand chunk playback error:', error);
            this.pause();
        };

        // Set up ended handler for next chunk (recursive)
        this.currentAudio.onended = () => {
            if (this.isPlaying) {
                if (this.currentChunkIndex < this.currentChunks.length - 1) {
                    // More chunks - play next synchronously
                    this.currentChunkIndex++;
                    this.playNextOnDemandChunkSync(text);
                } else {
                    // Move to next paragraph
                    this.nextParagraph();
                }
            }
        };

        // SYNCHRONOUS play() call - no await!
        this.currentAudio.play().catch(error => {
            console.error('Failed to play on-demand chunk:', error);
            this.pause();
        });
    }

    async checkForExistingChapterAudio(chapterIndex) {
        // Only check if we have book backend ID and are authenticated
        if (!this.book || !this.book.backendId || !ttsApi.isAuthenticated()) {
            return;
        }

        try {
            // Just check if chunk 0 exists (lightweight check)
            const result = await ttsApi.getChunkAudio(this.book.backendId, chapterIndex, 0);

            if (result && result.audioUrl) {
                console.log(`✅ Chapter ${chapterIndex} has pre-generated audio`);

                // Update button to indicate chapter audio is available
                const btn = document.getElementById('generate-chapter');
                if (btn) {
                    btn.textContent = '✓';
                    btn.title = 'Chapter audio ready (click to regenerate)';
                }
            } else {
                console.log(`No pre-generated audio for chapter ${chapterIndex}`);
            }
        } catch (error) {
            // 404 is expected if no audio exists, don't log error
            if (error.message && !error.message.includes('404')) {
                console.error('Failed to check for existing chapter audio:', error);
            }
        }
    }

    async generateCurrentChapterAudio() {
        if (!ttsApi.isAuthenticated()) {
            alert('Please login to generate chapter audio');
            return;
        }

        if (!this.book || !this.book.backendId) {
            alert('Book not synced to backend. Please upload the book first.');
            return;
        }

        // Get current chapter index
        const location = this.rendition.currentLocation();
        if (!location || !location.start) {
            alert('Cannot determine current chapter');
            return;
        }

        const chapterIndex = location.start.index;
        const btn = document.getElementById('generate-chapter');

        try {
            this.isGeneratingChapterAudio = true;

            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Loading...';
            }

            // Use already-loaded chapter chunks (deterministic)
            if (!this.chapterChunks || this.chapterChunks.length === 0) {
                console.log('Chapter chunks not loaded, loading now...');
                this.chapterChunks = await this.loadChapterChunks(chapterIndex);
            }

            const chunks = this.chapterChunks;

            if (chunks.length === 0) {
                alert('Could not load chapter content');
                return;
            }

            console.log(`Generating audio for ${chunks.length} chunks in chapter ${chapterIndex}...`);

            if (btn) {
                btn.textContent = '0%';
            }

            // Get settings
            const settings = storage.getSettings();
            const voiceId = settings.voiceId || 'en-US-Neural2-A';
            const speed = settings.speed || 1.0;
            const pitch = settings.pitch || 0;

            // Clear old cache
            this.chunkAudioCache.clear();

            // Generate audio for each chunk with rate limiting and retry on 429
            for (let i = 0; i < chunks.length; i++) {
                const text = chunks[i];

                // Update progress
                const progress = Math.round((i / chunks.length) * 100);
                if (btn) {
                    btn.textContent = `${progress}%`;
                }

                // Retry logic for 429 errors (quota exhausted)
                let result = null;
                let retryAttempt = 0;
                const MAX_RETRIES = 5;

                while (!result && retryAttempt <= MAX_RETRIES) {
                    try {
                        result = await ttsApi.generateChunkAudio(
                            this.book.backendId,
                            chapterIndex,
                            i,
                            text,
                            voiceId,
                            speed,
                            pitch
                        );
                    } catch (error) {
                        // Check if it's a 429 quota error
                        if (error.message && error.message.includes('429')) {
                            retryAttempt++;

                            if (retryAttempt > MAX_RETRIES) {
                                throw new Error(`Quota exceeded after ${MAX_RETRIES} retries. Please wait a few minutes and try again.`);
                            }

                            // Exponential backoff: 5s, 10s, 20s, 40s, 80s
                            const waitTime = Math.pow(2, retryAttempt) * 5000;
                            const waitSeconds = Math.round(waitTime / 1000);

                            console.warn(`⚠️ Quota exceeded (429), waiting ${waitSeconds}s before retry ${retryAttempt}/${MAX_RETRIES}...`);

                            if (btn) {
                                btn.textContent = `Wait ${waitSeconds}s`;
                            }

                            await new Promise(resolve => setTimeout(resolve, waitTime));

                            if (btn) {
                                btn.textContent = `${progress}%`;
                            }
                        } else {
                            // Not a 429 error, rethrow
                            throw error;
                        }
                    }
                }

                // Cache the audio URL
                this.chunkAudioCache.set(i, result.audioUrl);

                // Rate limiting: wait 200ms between requests to avoid quota issues
                if (i < chunks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

            console.log(`✅ Generated audio for ${chunks.length} chunks`);
            alert(`Chapter audio generated successfully! ${chunks.length} chunks ready.`);

            if (btn) {
                btn.disabled = false;
                btn.textContent = '✓';
                btn.title = 'Chapter audio ready (click to regenerate)';
            }
        } catch (error) {
            console.error('Failed to generate chapter audio:', error);
            alert(`Failed to generate chapter audio: ${error.message}`);

            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Gen';
            }
        } finally {
            this.isGeneratingChapterAudio = false;
        }
    }

    previousParagraph() {
        if (this.currentParagraphIndex > 0) {
            this.currentParagraphIndex--;

            if (this.isPlaying) {
                const paragraph = this.currentParagraphs[this.currentParagraphIndex];
                const text = paragraph.textContent || paragraph;
                this.speak(text);
            } else {
                this.highlightParagraph(this.currentParagraphIndex);
            }
        }
    }

    async nextParagraph() {
        if (this.currentParagraphIndex < this.currentParagraphs.length - 1) {
            this.currentParagraphIndex++;
            this.pageAdvanceFailures = 0; // Reset failure counter on successful paragraph advance

            if (this.isPlaying) {
                const paragraph = this.currentParagraphs[this.currentParagraphIndex];
                const text = paragraph.textContent || paragraph;
                await this.speak(text);
            } else {
                this.highlightParagraph(this.currentParagraphIndex);
            }
        } else {
            // At the end of current page paragraphs
            if (this.book.fileType === 'epub' && this.rendition) {
                // Check if we've failed too many times in a row
                if (this.pageAdvanceFailures >= 10) {
                    console.error('Failed to advance pages 10 times in a row, stopping to prevent infinite loop');
                    this.pause();
                    alert('Unable to continue reading. You may have reached the end of the book.');
                    this.pageAdvanceFailures = 0;
                    return;
                }

                // Store current location before moving
                const currentCfi = this.currentLocation;
                console.log('At end of page, attempting to move forward. Attempt:', this.pageAdvanceFailures + 1);

                // Move to next page in EPUB
                const moved = this.rendition.next();

                if (!moved) {
                    console.log('Reached end of book');
                    this.pause();
                    alert('Reached the end of the book!');
                    this.pageAdvanceFailures = 0;
                    return;
                }

                this.currentParagraphIndex = 0;

                if (this.isPlaying) {
                    // Wait for NEW text extraction (not the old one)
                    const oldPromise = this.textExtractionPromise;
                    console.log(`⏳ Waiting for new page to load...`);

                    // Wait until the relocated event fires and creates a new Promise
                    while (this.textExtractionPromise === oldPromise) {
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }

                    // Now wait for the new extraction to complete
                    await this.textExtractionPromise;
                    console.log(`✅ Text extraction completed`);

                    // Check if location actually changed
                    if (this.currentLocation === currentCfi) {
                        console.warn('Did not advance to new page (CFI unchanged)');
                        this.pageAdvanceFailures++;

                        // Try to advance again if we haven't hit the limit
                        if (this.pageAdvanceFailures < 3) {
                            console.log('Attempting to advance again...');
                            this.nextParagraph();
                        } else {
                            this.pause();
                            alert('Cannot advance further. Stopping playback.');
                            this.pageAdvanceFailures = 0;
                        }
                        return;
                    }

                    // Successfully moved to new page
                    this.pageAdvanceFailures = 0;

                    if (this.currentParagraphs.length > 0) {
                        const paragraph = this.currentParagraphs[0];
                        const text = paragraph.textContent || paragraph;
                        this.speak(text);
                    } else {
                        // Still no paragraphs after page turn - page is blank
                        console.warn('No text on next page - page appears to be blank');

                        // STOP - don't skip through chapters looking for text
                        // This prevents jumping from chapter 9 to chapter 14
                        this.pause();
                        alert('Reached a blank page. Playback stopped. Use arrow keys to navigate.');
                    }
                }
            } else {
                this.pause();
            }
        }
    }

    jumpToParagraph(index) {
        this.currentParagraphIndex = index;

        if (this.isPlaying) {
            const paragraph = this.currentParagraphs[this.currentParagraphIndex];
            const text = paragraph.textContent || paragraph;
            this.speak(text);
        } else {
            this.highlightParagraph(this.currentParagraphIndex);
        }
    }

    highlightParagraph(index) {
        if (this.currentParagraphs.length === 0) return;

        // Remove previous highlight
        this.removeHighlight();

        if (!this.currentParagraphs[index]) return;

        const paragraph = this.currentParagraphs[index];
        const textToFind = paragraph.textContent.trim();

        console.log(`🔍 HIGHLIGHT [Chunk ${index}/${this.currentParagraphs.length - 1}]: "${textToFind.substring(0, 50)}..."`);

        // For EPUB mode - find the text node fresh each time (stored reference may be stale)
        if (this.book.fileType === 'epub' && this.rendition) {
            console.log('  📍 Searching for chunk in current DOM...');

            const iframe = document.querySelector('#viewer iframe');
            if (!iframe || !iframe.contentDocument) {
                console.log('  ❌ Cannot access iframe');
                return;
            }

            const doc = iframe.contentDocument;
            const normalizedChunk = textToFind.replace(/\s+/g, ' ');

            // Walk DOM to find the text node that contains our chunk
            const walker = doc.createTreeWalker(
                doc.body,
                NodeFilter.SHOW_TEXT,
                null
            );

            let node;
            while (node = walker.nextNode()) {
                const originalText = node.textContent;
                const normalizedOriginal = originalText.replace(/\s+/g, ' ').trim();

                // Check if this node contains our chunk
                const normalizedIndex = normalizedOriginal.indexOf(normalizedChunk);

                if (normalizedIndex !== -1) {
                    console.log(`  ✅ Found chunk in text node!`);
                    console.log(`    Node: "${normalizedOriginal.substring(0, 60)}..."`);
                    console.log(`    Chunk position: ${normalizedIndex}`);

                    // Map normalized index to original text index
                    let originalIndex = 0;
                    let normalizedPos = 0;

                    for (let i = 0; i < originalText.length; i++) {
                        if (normalizedPos === normalizedIndex) {
                            originalIndex = i;
                            break;
                        }

                        const char = originalText[i];
                        if (/\s/.test(char)) {
                            if (i === 0 || !/\s/.test(originalText[i - 1])) {
                                normalizedPos++;
                            }
                        } else {
                            normalizedPos++;
                        }
                    }

                    // Calculate end index
                    let originalEndIndex = originalIndex;
                    let charsMatched = 0;

                    for (let i = originalIndex; i < originalText.length && charsMatched < normalizedChunk.length; i++) {
                        const char = originalText[i];
                        if (/\s/.test(char)) {
                            if (i === originalIndex || !/\s/.test(originalText[i - 1])) {
                                charsMatched++;
                            }
                        } else {
                            charsMatched++;
                        }
                        originalEndIndex = i + 1;
                    }

                    console.log(`    Original range: ${originalIndex}-${originalEndIndex}`);

                    try {
                        const range = doc.createRange();
                        range.setStart(node, originalIndex);
                        range.setEnd(node, originalEndIndex);

                        const highlightSpan = doc.createElement('span');
                        highlightSpan.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
                        highlightSpan.style.transition = 'background-color 0.2s ease';
                        highlightSpan.setAttribute('data-tts-highlight', 'true');

                        range.surroundContents(highlightSpan);
                        this.currentHighlightElement = highlightSpan;
                        highlightSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });

                        console.log('  ✅ Precise highlighting successful');
                        return;
                    } catch (e) {
                        console.log('  ⚠️ Range wrapping failed:', e.message);
                        // Try parent element highlight as fallback
                        const parentEl = node.parentElement;
                        if (parentEl) {
                            this.applyHighlight(parentEl);
                            return;
                        }
                    }
                }
            }

            console.log('  ⚠️ Chunk not found in any text node');
        }

        console.log('  ❌ Highlighting failed');
    }

    highlightTextWithRange(doc, searchText) {
        try {
            // Find the text node that contains our search text
            const walker = doc.createTreeWalker(
                doc.body,
                NodeFilter.SHOW_TEXT,
                null
            );

            console.log('📋 RANGE API DEBUG: Text nodes in document:');
            let nodeCount = 0;
            let node;
            while (node = walker.nextNode()) {
                const nodeText = node.textContent.replace(/\s+/g, ' ').trim();
                if (nodeText.length > 0) {
                    nodeCount++;
                    console.log(`  Text node ${nodeCount}: "${nodeText.substring(0, 60)}..." (${nodeText.length} chars)`);
                }
            }
            console.log(`  Total text nodes: ${nodeCount}`);

            // Try multiple segments of the search text (sliding window)
            const SEARCH_SIZE = 50;
            const STEP_SIZE = 50;

            for (let offset = 0; offset < searchText.length; offset += STEP_SIZE) {
                const searchFor = searchText.substring(offset, Math.min(offset + SEARCH_SIZE, searchText.length));

                // Skip if segment too short
                if (searchFor.trim().length < 20) {
                    continue;
                }

                console.log(`🔍 Trying segment at offset ${offset}: "${searchFor.substring(0, 40)}..."`);

                // Reset walker for each attempt
                const walker2 = doc.createTreeWalker(
                    doc.body,
                    NodeFilter.SHOW_TEXT,
                    null
                );

                while (node = walker2.nextNode()) {
                    const nodeText = node.textContent.replace(/\s+/g, ' ');
                    const index = nodeText.indexOf(searchFor);

                    if (index !== -1) {
                        console.log(`✅ Found at offset ${offset} in text node!`);

                        // Calculate how much of the chunk to highlight
                        // We want to highlight from the found position to the end of the chunk,
                        // or as much as fits in this text node
                        const remainingChunk = searchText.substring(offset);
                        const highlightLength = Math.min(remainingChunk.length, node.textContent.length - index);

                        console.log(`  Highlighting ${highlightLength} chars (chunk has ${remainingChunk.length} remaining, node has ${node.textContent.length - index} available)`);

                        // Create a range and wrap it in a highlighted span
                        const range = doc.createRange();
                        range.setStart(node, index);
                        range.setEnd(node, index + highlightLength);

                        // Create highlight span
                        const highlightSpan = doc.createElement('span');
                        highlightSpan.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
                        highlightSpan.style.transition = 'background-color 0.2s ease';
                        highlightSpan.setAttribute('data-tts-highlight', 'true');

                        try {
                            range.surroundContents(highlightSpan);
                            this.currentHighlightElement = highlightSpan;

                            // Scroll into view
                            highlightSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            return true;
                        } catch (e) {
                            // surroundContents can fail if range spans multiple elements
                            console.log('Could not wrap range:', e);
                            // Continue trying other offsets
                            break;
                        }
                    }
                }
            }

            console.log('❌ Could not find any segment in text nodes');
            return false;
        } catch (error) {
            console.error('Error in highlightTextWithRange:', error);
            return false;
        }
    }

    applyHighlight(el) {
        el.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
        el.style.transition = 'background-color 0.2s ease';
        this.currentHighlightElement = el;

        // Scroll into view
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    removeHighlight() {
        if (this.currentHighlightElement) {
            // Check if this is a span we created with Range API
            if (this.currentHighlightElement.hasAttribute &&
                this.currentHighlightElement.hasAttribute('data-tts-highlight')) {
                // Remove the span and put the text back
                const parent = this.currentHighlightElement.parentNode;
                if (parent) {
                    const doc = this.currentHighlightElement.ownerDocument;
                    const textNode = doc.createTextNode(this.currentHighlightElement.textContent);
                    parent.replaceChild(textNode, this.currentHighlightElement);
                    // Normalize to merge adjacent text nodes
                    parent.normalize();
                }
            } else {
                // Regular element highlight
                this.currentHighlightElement.style.backgroundColor = '';
            }
            this.currentHighlightElement = null;
        }
    }

    async saveReadingPosition() {
        if (this.book.fileType === 'epub' && this.currentChapterIndex !== null) {
            // Map current paragraph to chapter chunk (device-independent)
            let chapterChunkIndex = -1;

            if (this.currentParagraphs.length > 0 && this.chapterChunks.length > 0 && this.currentParagraphIndex >= 0) {
                const paragraph = this.currentParagraphs[this.currentParagraphIndex];
                const paragraphText = (paragraph.textContent || paragraph).replace(/\s+/g, ' ').trim();
                const searchText = paragraphText.substring(0, 100);

                for (let i = 0; i < this.chapterChunks.length; i++) {
                    const normalizedChunk = this.chapterChunks[i].replace(/\s+/g, ' ').trim();
                    if (normalizedChunk.includes(searchText) || searchText.includes(normalizedChunk.substring(0, 100))) {
                        chapterChunkIndex = i;
                        break;
                    }
                }
            }

            console.log(`💾 Saving position: chapter ${this.currentChapterIndex}, chunk ${chapterChunkIndex}`);

            await storage.saveReadingPosition(this.bookId, {
                type: 'epub',
                chapterIndex: this.currentChapterIndex,
                chapterChunkIndex: chapterChunkIndex
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
        try {
            // Set flag to prevent auto-saving during initial load
            this.isLoadingInitialPosition = true;

            // Clear any pending auto-save timeout from initial display()
            if (this.savePositionTimeout) {
                clearTimeout(this.savePositionTimeout);
                this.savePositionTimeout = null;
                console.log('🚫 Cleared pending auto-save to prevent overwriting saved position');
            }

            // Try to get position from backend first (if book is synced and user is authenticated)
            let backendPosition = null;
            if (this.book && this.book.backendId && ttsApi.isAuthenticated()) {
                console.log('🌐 Fetching position from backend for book:', this.book.backendId);
                try {
                    backendPosition = await ttsApi.getPosition(this.book.backendId);
                    if (backendPosition) {
                        console.log('📥 Loaded position from backend:', JSON.stringify(backendPosition, null, 2));
                    } else {
                        console.log('ℹ️ No position found in backend');
                    }
                } catch (error) {
                    console.error('❌ Failed to fetch position from backend:', error);
                }
            } else {
                console.log('ℹ️ Skipping backend position fetch:', {
                    hasBook: !!this.book,
                    hasBackendId: !!this.book?.backendId,
                    isAuthenticated: ttsApi.isAuthenticated()
                });
            }

            // Get local position from localStorage
            const localPosition = storage.getReadingPosition(this.bookId);
            if (localPosition) {
                console.log('💾 Local position found:', JSON.stringify(localPosition, null, 2));
            } else {
                console.log('ℹ️ No local position found');
            }

            // Choose the newer position (prefer backend if both exist)
            let position = null;
            if (backendPosition && localPosition) {
                // Compare timestamps (backend should have lastRead timestamp)
                const backendTime = backendPosition.lastRead ? new Date(backendPosition.lastRead).getTime() : 0;
                const localTime = localPosition.lastRead ? new Date(localPosition.lastRead).getTime() : 0;

                if (backendTime >= localTime) {
                    console.log('✅ Using backend position (newer)');
                    position = backendPosition;
                    // Save to localStorage to keep them in sync (without syncing back to backend)
                    const positions = storage.getAllReadingPositions();
                    positions[this.bookId] = position;
                    localStorage.setItem('readingPositions', JSON.stringify(positions));
                } else {
                    console.log('✅ Using local position (newer)');
                    position = localPosition;
                }
            } else if (backendPosition) {
                console.log('✅ Using backend position (no local)');
                position = backendPosition;
                // Save to localStorage (without syncing back to backend)
                const positions = storage.getAllReadingPositions();
                positions[this.bookId] = position;
                localStorage.setItem('readingPositions', JSON.stringify(positions));
            } else if (localPosition) {
                console.log('✅ Using local position (no backend)');
                position = localPosition;
            } else {
                console.log('ℹ️ No saved position found');
                return;
            }

            // Load the position
            if (position && position.type === 'epub' && position.chapterIndex !== undefined && this.rendition) {
                try {
                    // Navigate to saved chapter using device-independent chapter index
                    const section = this.epubBook.spine.get(position.chapterIndex);
                    if (!section) {
                        console.error('❌ Invalid chapter index:', position.chapterIndex);
                        return;
                    }

                    console.log(`📖 Loading chapter ${position.chapterIndex}, chunk ${position.chapterChunkIndex}...`);

                    // Load chapter chunks first to know where to jump
                    console.log(`📚 Loading chapter chunks for chapter ${position.chapterIndex}...`);
                    this.chapterChunks = await this.loadChapterChunks(position.chapterIndex);
                    this.currentChapterIndex = position.chapterIndex;

                    // Find the saved chunk text
                    if (position.chapterChunkIndex >= 0 && position.chapterChunkIndex < this.chapterChunks.length) {
                        const targetChunkText = this.chapterChunks[position.chapterChunkIndex];
                        const searchText = targetChunkText.substring(0, 100).replace(/\s+/g, ' ').trim();

                        console.log(`🎯 Looking for chunk ${position.chapterChunkIndex}: "${searchText.substring(0, 50)}..."`);

                        // Generate a CFI that points to this text within the chapter
                        // We'll search for the text in the chapter document
                        await section.load(this.epubBook.load.bind(this.epubBook));
                        const sectionDoc = section.document;

                        // Find the text in the chapter
                        const walker = sectionDoc.createTreeWalker(sectionDoc.body, NodeFilter.SHOW_TEXT, null);
                        let node;
                        let found = false;

                        while (node = walker.nextNode()) {
                            const nodeText = node.textContent.replace(/\s+/g, ' ').trim();
                            if (nodeText.includes(searchText) || searchText.includes(nodeText.substring(0, 100))) {
                                // Found it! Generate CFI for this node's parent element
                                const cfi = section.cfiFromElement(node.parentElement);
                                console.log(`✅ Found chunk in chapter, jumping to CFI: ${cfi}`);

                                // Jump directly to this CFI
                                await this.rendition.display(cfi);
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            console.log(`⚠️ Could not find chunk in chapter, jumping to chapter start`);
                            await this.rendition.display(section.href);
                        }

                        // Wait for page to load
                        await new Promise(resolve => setTimeout(resolve, 500));
                        await this.textExtractionPromise;

                        // Find and highlight the chunk on the current page
                        for (let i = 0; i < this.currentParagraphs.length; i++) {
                            const para = this.currentParagraphs[i];
                            const paraText = (para.textContent || para).replace(/\s+/g, ' ').trim();

                            if (paraText.includes(searchText) || searchText.includes(paraText.substring(0, 100))) {
                                console.log(`✅ Highlighted chunk at paragraph ${i}`);
                                this.currentParagraphIndex = i;
                                this.highlightParagraph(i);
                                break;
                            }
                        }
                    } else {
                        console.log(`ℹ️ No valid chunk index, starting from beginning of chapter`);
                        await this.rendition.display(section.href);
                        await new Promise(resolve => setTimeout(resolve, 500));
                        await this.textExtractionPromise;
                        this.currentParagraphIndex = 0;
                        this.highlightParagraph(0);
                    }

                    console.log(`✅ Position loaded: Chapter ${position.chapterIndex}, Chunk ${position.chapterChunkIndex}, Paragraph ${this.currentParagraphIndex}`);
                } catch (error) {
                    console.error('Failed to load position:', error);
                }
            } else if (position && position.type === 'pdf' && position.paragraphIndex !== undefined) {
                this.currentParagraphIndex = Math.min(position.paragraphIndex, this.currentParagraphs.length - 1);
                this.highlightParagraph(this.currentParagraphIndex);
                console.log('📖 Loaded PDF position:', position.paragraphIndex);
            }
        } finally {
            // Clear flag to allow normal auto-saving
            // This runs after the 500ms delay above, ensuring relocated event has finished
            this.isLoadingInitialPosition = false;
            console.log('🟢 Initial position load complete - auto-save now enabled');
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
