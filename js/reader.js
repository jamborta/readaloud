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

                // Extract text for TTS when page changes
                await this.extractCurrentPageText();
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

            // Extract initial page text after a short delay to ensure relocated event has fired
            setTimeout(async () => {
                await this.extractCurrentPageText();
                console.log('Initial text extraction complete');
            }, 500);

            console.log('EPUB rendered successfully');

        } catch (error) {
            console.error('Error rendering EPUB:', error);
            document.getElementById('area').innerHTML = `<p style="padding: 2rem;">Error loading EPUB: ${error.message}. Please try a different file.</p>`;
        }
    }

    async extractCurrentPageText() {
        try {
            if (!this.rendition || !this.epubBook) {
                console.error('❌ Rendition or book not ready');
                return;
            }

            const location = this.rendition.currentLocation();
            if (!location || !location.start || !location.end) {
                console.error('❌ No location available');
                return;
            }

            console.log('📍 Extracting text from current page...');

            try {
                const startCfi = location.start.cfi;
                const endCfi = location.end.cfi;

                // Use proper CFI range method from EPUB.js community (THIS WORKED!)
                const rangeCfi = this.makeRangeCfi(startCfi, endCfi);
                const range = await this.epubBook.getRange(rangeCfi);

                if (!range) {
                    console.warn('⚠️ getRange() returned null');
                    this.currentParagraphs = [];
                    return;
                }

                const visibleText = range.toString();

                if (visibleText.length === 0) {
                    console.warn('⚠️ Range returned empty text');
                    this.currentParagraphs = [];
                    return;
                }

                console.log(`✅ Got ${visibleText.length} characters from CFI range`);

                // Split into paragraphs by sentence groups
                const paragraphs = visibleText.split(/\n\n+/);
                const paragraphData = [];

                paragraphs.forEach(para => {
                    const trimmed = para.trim().replace(/\s+/g, ' ');
                    if (trimmed.length >= 30) {
                        paragraphData.push({ textContent: trimmed });
                    }
                });

                // If we got very few paragraphs, split by sentences instead
                if (paragraphData.length < 2) {
                    paragraphData.length = 0;
                    const sentences = visibleText.split(/(?<=[.!?])\s+/);
                    let currentPara = '';

                    sentences.forEach(sentence => {
                        const trimmed = sentence.trim();
                        if (!trimmed) return;

                        if (currentPara.length + trimmed.length < 500) {
                            currentPara += (currentPara ? ' ' : '') + trimmed;
                        } else {
                            if (currentPara.length >= 30) {
                                paragraphData.push({ textContent: currentPara });
                            }
                            currentPara = trimmed;
                        }
                    });

                    if (currentPara.length >= 30) {
                        paragraphData.push({ textContent: currentPara });
                    }
                }

                this.currentParagraphs = paragraphData;
                this.currentParagraphIndex = 0;

                // Track for loop detection
                const firstParagraphText = paragraphData.length > 0 ? paragraphData[0].textContent : null;
                this.lastExtractedText = firstParagraphText;
                this.lastSectionIndex = location.start.index;

                console.log(`✅ Extracted ${this.currentParagraphs.length} paragraphs`);

                if (this.currentParagraphs.length > 0) {
                    console.log('📖 First:', this.currentParagraphs[0].textContent.substring(0, 80) + '...');
                }

            } catch (error) {
                console.error('❌ CFI extraction failed:', error);
                this.currentParagraphs = [];
            }

        } catch (error) {
            console.error('❌ CRITICAL ERROR in extractCurrentPageText:', error);
            this.currentParagraphs = [];
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
                // Check if we have any paragraphs - if not, stop
                if (this.currentParagraphs.length === 0) {
                    console.warn('No text extracted from page, stopping playback');
                    this.pause();
                    alert('Could not extract text from this page. TTS has been stopped.');
                    return;
                }

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
                    // Wait for page to load and check if we actually moved
                    setTimeout(() => {
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

                        // Check if we're stuck (same section AND same text)
                        const currentLocation = this.rendition.currentLocation();
                        if (currentLocation && currentLocation.start && this.lastSectionIndex !== null) {
                            const currentSectionIndex = currentLocation.start.index;
                            const currentFirstParagraph = this.currentParagraphs.length > 0 ? this.currentParagraphs[0].textContent : null;

                            // ONLY force section jump if BOTH section AND text are the same
                            if (currentSectionIndex === this.lastSectionIndex &&
                                currentFirstParagraph === this.lastExtractedText &&
                                currentFirstParagraph !== null) {

                                console.warn(`Still in same section ${currentSectionIndex} AND same text after page turn - forcing jump to next section`);

                                // Get the next section
                                const nextSection = this.epubBook.spine.get(currentSectionIndex + 1);
                                if (nextSection) {
                                    console.log(`Jumping to next section: ${nextSection.href}`);
                                    this.rendition.display(nextSection.href);

                                    // Wait for new content to be extracted
                                    setTimeout(() => {
                                        if (this.currentParagraphs.length > 0 && this.isPlaying) {
                                            const paragraph = this.currentParagraphs[0];
                                            const text = paragraph.textContent || paragraph;
                                            this.speak(text);
                                        } else {
                                            console.warn('No text in next section');
                                            this.nextParagraph();
                                        }
                                    }, 800);
                                } else {
                                    console.log('No more sections - reached end of book');
                                    this.pause();
                                    alert('Reached the end of the book!');
                                }
                                return;
                            }
                        }

                        // Successfully moved to new page with new content
                        this.pageAdvanceFailures = 0;

                        if (this.currentParagraphs.length > 0) {
                            const paragraph = this.currentParagraphs[0];
                            const text = paragraph.textContent || paragraph;
                            this.speak(text);
                        } else {
                            // Still no paragraphs after page turn
                            console.warn('No text on next page');
                            this.pageAdvanceFailures++;

                            // Try to advance again
                            if (this.pageAdvanceFailures < 3) {
                                console.log('No text found, trying next page...');
                                this.nextParagraph();
                            } else {
                                this.pause();
                                alert('No text found on next pages. Stopping playback.');
                                this.pageAdvanceFailures = 0;
                            }
                        }
                    }, 800);
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

        if (this.currentParagraphs[index]) {
            const paragraph = this.currentParagraphs[index];

            // For EPUB mode - directly access iframe and highlight text
            if (this.book.fileType === 'epub' && this.rendition) {
                try {
                    console.log('Highlighting paragraph:', paragraph.textContent.substring(0, 50) + '...');

                    // Get the rendered iframe
                    const iframe = document.querySelector('#viewer iframe');
                    if (!iframe || !iframe.contentDocument) {
                        console.warn('Could not access iframe');
                        return;
                    }

                    const doc = iframe.contentDocument;
                    const textToFind = paragraph.textContent.trim();

                    // Find the text in the document using a text walker
                    this.highlightTextInIframe(doc, textToFind);

                } catch (e) {
                    console.error('Could not highlight paragraph:', e);
                }
            }

            // For PDF mode - use classList
            if (paragraph.classList) {
                this.currentParagraphs.forEach(p => {
                    if (p.classList) {
                        p.classList.remove('active-paragraph');
                    }
                });
                paragraph.classList.add('active-paragraph');
                paragraph.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    highlightTextInIframe(doc, searchText) {
        if (!doc || !doc.body) {
            console.warn('❌ No doc or body for highlighting');
            return;
        }

        console.log('🔍 Searching for text to highlight:', searchText.substring(0, 100));

        // Normalize search text for comparison
        const normalizeText = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase();
        const normalizedSearch = normalizeText(searchText);

        // Try to find matching element - be more flexible with matching
        const allElements = doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, span, section, article');

        console.log('🔍 Checking', allElements.length, 'elements');

        for (const el of allElements) {
            const elementText = el.textContent.trim();
            const normalizedElement = normalizeText(elementText);

            // Strategy 1: Exact match (case-insensitive, whitespace normalized)
            if (normalizedSearch === normalizedElement) {
                console.log('✅ Found exact match!');
                this.applyHighlight(el);
                return;
            }

            // Strategy 2: Match first 50 chars
            const compareLength = Math.min(50, normalizedSearch.length, normalizedElement.length);
            if (compareLength > 20 && normalizedSearch.substring(0, compareLength) === normalizedElement.substring(0, compareLength)) {
                console.log('✅ Found match by first 50 chars!');
                this.applyHighlight(el);
                return;
            }

            // Strategy 3: Element contains the search text
            if (normalizedElement.includes(normalizedSearch) && normalizedSearch.length > 20) {
                console.log('✅ Found match - element contains search text!');
                this.applyHighlight(el);
                return;
            }

            // Strategy 4: Search text contains the element (for short elements)
            if (normalizedSearch.includes(normalizedElement) && normalizedElement.length > 20) {
                console.log('✅ Found match - search contains element text!');
                this.applyHighlight(el);
                return;
            }
        }

        console.warn('❌ Could not find matching element to highlight for:', searchText.substring(0, 50));
    }

    applyHighlight(el) {
        el.style.backgroundColor = 'rgba(255, 255, 0, 0.4)';
        el.style.transition = 'background-color 0.3s ease';
        el.setAttribute('data-tts-highlight', 'true');

        // Store reference for removal
        this.currentHighlightElement = el;

        // Scroll into view
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });

        console.log('✅ Highlighted element:', el.tagName, 'Text:', el.textContent.substring(0, 100));
    }

    removeHighlight() {
        try {
            // Remove direct element highlighting
            if (this.currentHighlightElement) {
                this.currentHighlightElement.style.backgroundColor = '';
                this.currentHighlightElement.removeAttribute('data-tts-highlight');
                this.currentHighlightElement = null;
            }

            // Also clean up any leftover highlights in iframe
            const iframe = document.querySelector('#viewer iframe');
            if (iframe && iframe.contentDocument) {
                const doc = iframe.contentDocument;
                const highlighted = doc.querySelectorAll('[data-tts-highlight]');
                highlighted.forEach(el => {
                    el.style.backgroundColor = '';
                    el.removeAttribute('data-tts-highlight');
                });
            }
        } catch (e) {
            console.warn('Could not remove highlight:', e);
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
