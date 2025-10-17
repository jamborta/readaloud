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

        // Note: Position is saved by:
        // 1. Close button (explicit save before navigation)
        // 2. Pause button (saves when audio stops)
        // 3. Auto-save (debounced 3s after page navigation)
        // No need for beforeunload - it can cause race conditions
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
                if (this.savePositionTimeout) {
                    clearTimeout(this.savePositionTimeout);
                }

                if (!this.isPlaying) {
                    this.savePositionTimeout = setTimeout(() => {
                        this.saveReadingPosition();
                    }, 3000);
                }

                // Clear old highlight when page changes
                this.removeHighlight();

                // Extract text for TTS when page changes - pass location to avoid stale data
                await this.extractCurrentPageText(location);
            });

            // Get initial position from localStorage and backend
            console.log('🔍 Loading reading position...');
            const savedPosition = await this.getInitialPosition();

            // Log to backend for mobile debugging
            ttsApi.sendLog('info', 'Loading reading position', {
                hasSavedPosition: !!savedPosition,
                positionType: savedPosition?.type,
                cfi: savedPosition?.cfi,
                paragraphIndex: savedPosition?.paragraphIndex,
                paragraphText: savedPosition?.paragraphText?.substring(0, 50)
            });

            // Display the book at saved position or beginning
            if (savedPosition && savedPosition.type === 'epub' && savedPosition.cfi) {
                console.log('📂 Opening book at saved position:', savedPosition.cfi);

                // Store paragraph info for restoration BEFORE display triggers relocated event
                this._savedParagraphText = savedPosition.paragraphText;
                this._savedParagraphIndex = savedPosition.paragraphIndex;

                await this.rendition.display(savedPosition.cfi);
            } else {
                console.log('📂 Opening book at beginning...');
                await this.rendition.display();
            }

            // Set initial location
            if (this.rendition.currentLocation()) {
                this.currentLocation = this.rendition.currentLocation().start.cfi;
                console.log('📍 Current CFI:', this.currentLocation);
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

                // Restore saved paragraph position if this is initial load
                if (this._savedParagraphText || this._savedParagraphIndex >= 0) {
                    console.log('📍 Restoring paragraph position after text extraction...');

                    let restored = false;
                    let restoreMethod = 'none';

                    if (this._savedParagraphText && this.currentParagraphs.length > 0) {
                        // Try to find by text match
                        const searchText = this._savedParagraphText.substring(0, 100);
                        let found = false;
                        for (let i = 0; i < this.currentParagraphs.length; i++) {
                            const para = this.currentParagraphs[i];
                            const paraText = (para.textContent || para).trim();
                            if (paraText.includes(searchText) || paraText.startsWith(searchText.substring(0, 50))) {
                                console.log(`✅ Found saved paragraph at index ${i}`);
                                this.currentParagraphIndex = i;
                                this.highlightParagraph(i);
                                found = true;
                                restored = true;
                                restoreMethod = 'text-match';
                                break;
                            }
                        }

                        if (!found && this._savedParagraphIndex >= 0 && this._savedParagraphIndex < this.currentParagraphs.length) {
                            console.log(`⚠️ Text match failed, using index: ${this._savedParagraphIndex}`);
                            this.currentParagraphIndex = this._savedParagraphIndex;
                            this.highlightParagraph(this.currentParagraphIndex);
                            restored = true;
                            restoreMethod = 'index-fallback';
                        }
                    } else if (this._savedParagraphIndex >= 0 && this._savedParagraphIndex < this.currentParagraphs.length) {
                        // Fall back to index
                        console.log(`✅ Restoring paragraph by index: ${this._savedParagraphIndex}`);
                        this.currentParagraphIndex = this._savedParagraphIndex;
                        this.highlightParagraph(this.currentParagraphIndex);
                        restored = true;
                        restoreMethod = 'index-only';
                    }

                    // Log restore result
                    ttsApi.sendLog('info', 'Paragraph position restored', {
                        restored,
                        restoreMethod,
                        savedParagraphIndex: this._savedParagraphIndex,
                        restoredParagraphIndex: this.currentParagraphIndex,
                        totalParagraphs: this.currentParagraphs.length,
                        hadParagraphText: !!this._savedParagraphText
                    });

                    // Clear the saved values so we don't restore again on page turn
                    this._savedParagraphText = null;
                    this._savedParagraphIndex = -1;
                }

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

            // Load the section content
            await section.load(this.epubBook.load.bind(this.epubBook));
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
                            this.nextChapterChunk();
                        }
                    };

                    await this.currentAudio.play();
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
        // Original on-demand TTS logic
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

                        // Check if element is in viewport before scrolling (prevents page jumps)
                        const rect = highlightSpan.getBoundingClientRect();
                        const iframeWindow = iframe.contentWindow;
                        const isInViewport = rect.top >= 0 &&
                                           rect.left >= 0 &&
                                           rect.bottom <= iframeWindow.innerHeight &&
                                           rect.right <= iframeWindow.innerWidth;

                        // Only scroll if element is already on current page or just slightly out of view
                        // This prevents jumping to previous pages where paragraph started
                        if (!isInViewport && Math.abs(rect.top) < iframeWindow.innerHeight) {
                            // Element is close but not in view, safe to scroll
                            highlightSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        } else if (!isInViewport) {
                            // Element is on a different page, don't scroll (prevents page jump)
                            console.log('  ⚠️ Element on different page, skipping scroll to prevent navigation');
                        }

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

                            // Check if element is in viewport before scrolling (prevents page jumps)
                            const rect = highlightSpan.getBoundingClientRect();
                            const iframeWindow = highlightSpan.ownerDocument.defaultView;
                            if (iframeWindow) {
                                const isInViewport = rect.top >= 0 &&
                                                   rect.left >= 0 &&
                                                   rect.bottom <= iframeWindow.innerHeight &&
                                                   rect.right <= iframeWindow.innerWidth;

                                // Only scroll if element is close to viewport
                                if (!isInViewport && Math.abs(rect.top) < iframeWindow.innerHeight) {
                                    highlightSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                } else if (!isInViewport) {
                                    console.log('  ⚠️ Element on different page, skipping scroll');
                                }
                            }
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

        // Check if element is in viewport before scrolling (prevents page jumps)
        const rect = el.getBoundingClientRect();
        const win = el.ownerDocument.defaultView;
        if (win) {
            const isInViewport = rect.top >= 0 &&
                               rect.left >= 0 &&
                               rect.bottom <= win.innerHeight &&
                               rect.right <= win.innerWidth;

            // Only scroll if element is close to viewport
            if (!isInViewport && Math.abs(rect.top) < win.innerHeight) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else if (!isInViewport) {
                console.log('⚠️ Element on different page, skipping scroll to prevent navigation');
            }
        }
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

    async getInitialPosition() {
        /**
         * Get initial reading position, checking both local and backend
         * If they differ, prompt user to choose which position to use
         * Returns: position object or null
         */

        // Get local position
        const localPosition = storage.getReadingPosition(this.bookId);
        console.log('💾 Local position:', localPosition?.cfi || localPosition?.paragraphIndex || 'none');

        // Get backend position if authenticated
        let backendPosition = null;
        if (this.book && this.book.backendId && ttsApi.isAuthenticated()) {
            try {
                backendPosition = await ttsApi.getPosition(this.book.backendId);
                console.log('🌐 Backend position:', backendPosition?.cfi || backendPosition?.paragraphIndex || 'none');
            } catch (error) {
                console.error('Failed to fetch backend position:', error);
            }
        }

        // If we only have one source, use it
        if (!localPosition && !backendPosition) {
            console.log('ℹ️ No saved position found');
            return null;
        }
        if (localPosition && !backendPosition) {
            console.log('✅ Using local position (no backend)');
            return localPosition;
        }
        if (!localPosition && backendPosition) {
            console.log('✅ Using backend position (no local)');
            return backendPosition;
        }

        // Both exist - check if they're different
        const localCfi = localPosition.cfi || '';
        const backendCfi = backendPosition.cfi || '';
        const localPara = localPosition.paragraphIndex || 0;
        const backendPara = backendPosition.paragraphIndex || 0;

        const areDifferent = (localPosition.type === 'epub' && localCfi !== backendCfi) ||
                            (localPosition.type === 'pdf' && localPara !== backendPara);

        if (!areDifferent) {
            console.log('✅ Local and backend positions match');
            return localPosition;
        }

        // Positions differ - prompt user to choose
        console.log('⚠️ Local and backend positions differ');

        const localTime = localPosition.lastRead ? new Date(localPosition.lastRead) : null;
        const backendTime = backendPosition.lastRead ? new Date(backendPosition.lastRead) : null;

        const localTimeStr = localTime ? localTime.toLocaleString() : 'Unknown';
        const backendTimeStr = backendTime ? backendTime.toLocaleString() : 'Unknown';

        const message = `This book has different reading positions:\n\n` +
                       `📱 This device: Last read ${localTimeStr}\n` +
                       `☁️ Cloud: Last read ${backendTimeStr}\n\n` +
                       `Which position would you like to use?`;

        const useBackend = confirm(message + '\n\nClick OK for Cloud position, Cancel for This device');

        if (useBackend) {
            console.log('✅ User chose backend position');
            // Save backend position to localStorage to sync them
            const positions = storage.getAllReadingPositions();
            positions[this.bookId] = backendPosition;
            localStorage.setItem('readingPositions', JSON.stringify(positions));
            return backendPosition;
        } else {
            console.log('✅ User chose local position');
            // Update backend with local position
            if (this.book && this.book.backendId && ttsApi.isAuthenticated()) {
                try {
                    const positionData = {
                        bookId: this.book.backendId,
                        type: localPosition.type
                    };
                    if (localPosition.type === 'epub' && localPosition.cfi) {
                        positionData.cfi = localPosition.cfi;
                    } else if (localPosition.type === 'pdf') {
                        positionData.paragraphIndex = localPosition.paragraphIndex;
                        positionData.totalParagraphs = localPosition.totalParagraphs;
                    }
                    await ttsApi.savePosition(positionData);
                } catch (error) {
                    console.error('Failed to sync local position to backend:', error);
                }
            }
            return localPosition;
        }
    }

    async saveReadingPosition() {
        if (this.book.fileType === 'epub' && this.currentLocation) {
            // Strategy: Save page start CFI (reliable) + paragraph text for precise restore
            const currentLoc = this.rendition ? this.rendition.currentLocation() : null;
            const pageStartCfi = currentLoc ? currentLoc.start.cfi : this.currentLocation;

            // If we have a highlighted paragraph, save its text for precise restore
            let paragraphText = null;
            if (this.currentParagraphIndex >= 0 && this.currentParagraphs[this.currentParagraphIndex]) {
                const paragraph = this.currentParagraphs[this.currentParagraphIndex];
                paragraphText = (paragraph.textContent || paragraph).trim().substring(0, 200);
            }

            // Log to backend for debugging
            ttsApi.sendLog('info', 'Saving reading position', {
                cfi: pageStartCfi,
                paragraphIndex: this.currentParagraphIndex,
                hasParagraphText: !!paragraphText,
                paragraphTextPreview: paragraphText?.substring(0, 50),
                totalParagraphs: this.currentParagraphs.length
            });

            await storage.saveReadingPosition(this.bookId, {
                cfi: pageStartCfi,
                paragraphText: paragraphText,
                paragraphIndex: this.currentParagraphIndex,
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
