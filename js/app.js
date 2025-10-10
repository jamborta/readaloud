// Library Management Application
let books = [];

// Initialize the app
async function init() {
    try {
        await storage.init();
        await loadLibrary();
        setupEventListeners();
    } catch (error) {
        console.error('Failed to initialize app:', error);
        alert('Failed to initialize the application. Please refresh the page.');
    }
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
