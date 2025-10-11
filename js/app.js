// Library Management Application
let books = [];

// Initialize the app
async function init() {
    try {
        await storage.init();
        updateAuthUI();
        setupEventListeners();

        // Require authentication - show only login if not authenticated
        if (!ttsApi.isAuthenticated()) {
            hideAllContent();
            await authManager.requireAuth();
            // After successful login, show content and load library
            showAllContent();
            await storage.syncBooksFromBackend();
            await loadLibrary();
            updateAuthUI();
        } else {
            // Already logged in - sync and load library
            showAllContent();
            await storage.syncBooksFromBackend();
            await loadLibrary();
        }
    } catch (error) {
        console.error('Failed to initialize app:', error);
        alert('Failed to initialize the application. Please refresh the page.');
    }
}

// Hide all content except auth UI
function hideAllContent() {
    document.querySelector('.upload-section').style.display = 'none';
    document.getElementById('library-grid').style.display = 'none';
    document.getElementById('empty-state').style.display = 'none';
}

// Show all content after authentication
function showAllContent() {
    document.querySelector('.upload-section').style.display = 'block';
    document.getElementById('library-grid').style.display = 'grid';
    // Don't set empty-state display - let renderLibrary() control it
}

// Update auth UI based on login status
function updateAuthUI() {
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const usernameDisplay = document.getElementById('username-display');

    if (ttsApi.isAuthenticated()) {
        // User is logged in
        const token = localStorage.getItem('auth_token');
        try {
            // Decode JWT to get username (basic decode, not verified)
            const payload = JSON.parse(atob(token.split('.')[1]));
            const username = payload.sub;

            loginBtn.style.display = 'none';
            usernameDisplay.textContent = `👤 ${username}`;
            usernameDisplay.style.display = 'inline-block';
            logoutBtn.style.display = 'inline-block';
        } catch (error) {
            console.error('Failed to decode token:', error);
            showLoginButton();
        }
    } else {
        showLoginButton();
    }
}

function showLoginButton() {
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const usernameDisplay = document.getElementById('username-display');

    loginBtn.style.display = 'inline-block';
    usernameDisplay.style.display = 'none';
    logoutBtn.style.display = 'none';
}

// Load all books from storage
async function loadLibrary() {
    try {
        books = await storage.getAllBooks();
        renderLibrary();
    } catch (error) {
        console.error('Failed to load library:', error);
    }
}

// Render the library grid
function renderLibrary() {
    const grid = document.getElementById('library-grid');
    const emptyState = document.getElementById('empty-state');

    if (books.length === 0) {
        grid.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    grid.innerHTML = books.map(book => createBookCard(book)).join('');

    // Add click handlers to book cards
    document.querySelectorAll('.book-card').forEach(card => {
        const bookId = card.dataset.bookId;

        card.addEventListener('click', (e) => {
            if (!e.target.classList.contains('delete-btn')) {
                openBook(bookId);
            }
        });
    });

    // Add delete handlers
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const bookId = btn.dataset.bookId;
            deleteBook(bookId);
        });
    });
}

// Create HTML for a book card
function createBookCard(book) {
    const icon = book.fileType === 'pdf' ? '📄' : '📕';
    return `
        <div class="book-card" data-book-id="${book.id}">
            <div class="book-cover">${icon}</div>
            <div class="book-info">
                <h3>${escapeHtml(book.title)}</h3>
                <p>${escapeHtml(book.author)}</p>
            </div>
            <button class="delete-btn" data-book-id="${book.id}" title="Delete book">×</button>
        </div>
    `;
}

// Setup event listeners
function setupEventListeners() {
    const fileInput = document.getElementById('file-upload');
    fileInput.addEventListener('change', handleFileUpload);

    // Auth buttons
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');

    loginBtn.addEventListener('click', async () => {
        try {
            await authManager.showAuthModal();
            updateAuthUI();

            // Show content and sync books from backend after login
            showAllContent();
            await storage.syncBooksFromBackend();
            await loadLibrary();
        } catch (error) {
            console.error('Login failed:', error);
        }
    });

    logoutBtn.addEventListener('click', () => {
        authManager.logout();
        hideAllContent();
        updateAuthUI();
    });

    // Settings button and modal
    setupSettingsModal();
}

// Setup settings modal
function setupSettingsModal() {
    const settingsBtn = document.getElementById('settings-btn');
    const settingsModal = document.getElementById('settings-modal');
    const settingsOverlay = document.querySelector('.settings-overlay');
    const settingsClose = document.querySelector('.settings-close');

    // Load voices if authenticated
    if (ttsApi.isAuthenticated()) {
        loadVoicesForSettings();
    }

    // Load current settings
    loadSettingsUI();

    // Open settings modal
    settingsBtn.addEventListener('click', () => {
        settingsModal.classList.add('active');
        settingsOverlay.classList.add('active');
        loadSettingsUI(); // Reload settings when opening modal
    });

    // Close settings modal
    const closeModal = () => {
        settingsModal.classList.remove('active');
        settingsOverlay.classList.remove('active');
    };

    settingsClose.addEventListener('click', closeModal);
    settingsOverlay.addEventListener('click', closeModal);

    // Theme select
    const themeSelect = document.getElementById('theme-select');
    themeSelect.addEventListener('change', (e) => {
        const theme = e.target.value;
        storage.saveSettings({ theme });
    });

    // Font size select
    const fontSizeSelect = document.getElementById('font-size-select');
    fontSizeSelect.addEventListener('change', (e) => {
        const fontSize = e.target.value;
        storage.saveSettings({ fontSize });
    });

    // Voice select
    const voiceSelect = document.getElementById('voice-select');
    voiceSelect.addEventListener('change', (e) => {
        storage.saveSettings({ voiceId: e.target.value });
    });

    // Speed select
    const speedSelect = document.getElementById('speed-select');
    speedSelect.addEventListener('change', (e) => {
        const speed = parseFloat(e.target.value);
        storage.saveSettings({ speed });
    });

    // Pitch select
    const pitchSelect = document.getElementById('pitch-select');
    pitchSelect.addEventListener('change', (e) => {
        const pitch = parseFloat(e.target.value);
        storage.saveSettings({ pitch });
    });
}

// Load settings into UI
function loadSettingsUI() {
    const settings = storage.getSettings();

    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
        themeSelect.value = settings.theme || 'light';
    }

    const fontSizeSelect = document.getElementById('font-size-select');
    if (fontSizeSelect) {
        fontSizeSelect.value = settings.fontSize || 'medium';
    }

    const speedSelect = document.getElementById('speed-select');
    if (speedSelect) {
        speedSelect.value = settings.speed || 1.0;
    }

    const pitchSelect = document.getElementById('pitch-select');
    if (pitchSelect) {
        pitchSelect.value = settings.pitch || 0;
    }

    const voiceSelect = document.getElementById('voice-select');
    if (voiceSelect && settings.voiceId) {
        voiceSelect.value = settings.voiceId;
    }
}

// Load voices for settings modal
async function loadVoicesForSettings() {
    try {
        const voices = await ttsApi.getVoices();
        const voiceSelect = document.getElementById('voice-select');

        if (voices.length > 0) {
            voiceSelect.innerHTML = voices.map(voice => {
                return `<option value="${voice.id}">${voice.name}</option>`;
            }).join('');

            const settings = storage.getSettings();
            if (settings.voiceId) {
                voiceSelect.value = settings.voiceId;
            }
        }
    } catch (error) {
        console.error('Failed to load voices:', error);
        const voiceSelect = document.getElementById('voice-select');
        if (error.message.includes('login')) {
            voiceSelect.innerHTML = '<option>Login to load voices</option>';
        } else {
            voiceSelect.innerHTML = '<option>Error loading voices</option>';
        }
    }
}

// Handle file upload
async function handleFileUpload(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    for (const file of files) {
        try {
            await processFile(file);
        } catch (error) {
            console.error(`Failed to process file ${file.name}:`, error);
            alert(`Failed to add "${file.name}". Please make sure it's a valid EPUB or PDF file.`);
        }
    }

    // Clear the input
    event.target.value = '';
}

// Process uploaded file
async function processFile(file) {
    const fileType = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'epub';

    // Read file as ArrayBuffer
    const fileData = await file.arrayBuffer();

    // Extract basic metadata
    let title = file.name.replace(/\.(epub|pdf)$/i, '');
    let author = 'Unknown Author';

    // Try to extract metadata from EPUB
    if (fileType === 'epub') {
        try {
            const metadata = await extractEpubMetadata(fileData);
            if (metadata.title) title = metadata.title;
            if (metadata.author) author = metadata.author;
        } catch (error) {
            console.warn('Could not extract EPUB metadata:', error);
        }
    }

    // Save book to storage
    const book = await storage.addBook({
        title,
        author,
        fileType,
        fileData: Array.from(new Uint8Array(fileData))
    });

    // Reload library
    await loadLibrary();
}

// Extract metadata from EPUB (basic implementation)
async function extractEpubMetadata(arrayBuffer) {
    // This is a simplified metadata extraction
    // In production, you'd use epub.js properly for this
    try {
        const uint8Array = new Uint8Array(arrayBuffer);
        const text = new TextDecoder('utf-8').decode(uint8Array);

        const titleMatch = text.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
        const authorMatch = text.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);

        return {
            title: titleMatch ? titleMatch[1].trim() : null,
            author: authorMatch ? authorMatch[1].trim() : null
        };
    } catch (error) {
        return { title: null, author: null };
    }
}

// Open a book in the reader
function openBook(bookId) {
    window.location.href = `reader.html?bookId=${bookId}`;
}

// Delete a book
async function deleteBook(bookId) {
    const book = books.find(b => b.id === bookId);
    if (!book) return;

    const confirmed = confirm(`Are you sure you want to delete "${book.title}"?`);
    if (!confirmed) return;

    try {
        await storage.deleteBook(bookId);
        await loadLibrary();
    } catch (error) {
        console.error('Failed to delete book:', error);
        alert('Failed to delete the book. Please try again.');
    }
}

// Utility function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
