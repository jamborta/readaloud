// Replacement for generateCurrentChapterAudio method
async generateCurrentChapterAudio() {
    if (!ttsApi.isAuthenticated()) {
        alert('Please login to generate chapter audio');
        return;
    }

    if (!this.book || !this.book.backendId) {
        alert('Book not synced to backend. Please upload the book first.');
        return;
    }

    if (this.currentParagraphs.length === 0) {
        alert('No text available. Please wait for the page to load.');
        return;
    }

    // Get current chapter index
    const location = this.rendition.currentLocation();
    if (!location || !location.start) {
        alert('Cannot determine current chapter');
        return;
    }

    const chapterIndex = location.start.index;
    console.log(`Generating audio for ${this.currentParagraphs.length} chunks in chapter ${chapterIndex}...`);

    const btn = document.getElementById('generate-chapter');

    try {
        this.isGeneratingChapterAudio = true;

        if (btn) {
            btn.disabled = true;
            btn.textContent = '0%';
        }

        // Get settings
        const settings = storage.getSettings();
        const voiceId = settings.voiceId || 'en-US-Neural2-A';
        const speed = settings.speed || 1.0;
        const pitch = settings.pitch || 0;

        // Clear old cache
        this.chunkAudioCache.clear();

        // Generate audio for each chunk
        for (let i = 0; i < this.currentParagraphs.length; i++) {
            const para = this.currentParagraphs[i];
            const text = para.textContent || para;

            // Update progress
            const progress = Math.round((i / this.currentParagraphs.length) * 100);
            if (btn) {
                btn.textContent = `${progress}%`;
            }

            const result = await ttsApi.generateChunkAudio(
                this.book.backendId,
                chapterIndex,
                i,
                text,
                voiceId,
                speed,
                pitch
            );

            // Cache the audio URL
            this.chunkAudioCache.set(i, result.audioUrl);
        }

        this.currentChapterIndex = chapterIndex;

        console.log(`✅ Generated audio for ${this.currentParagraphs.length} chunks`);
        alert(`Chapter audio generated successfully! ${this.currentParagraphs.length} chunks ready.`);

        if (btn) {
            btn.disabled = false;
            btn.textContent = '✅';
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
