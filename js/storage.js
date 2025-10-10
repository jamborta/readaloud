// Storage Manager for IndexedDB and localStorage
class StorageManager {
    constructor() {
        this.dbName = 'ReadAloudDB';
        this.dbVersion = 1;
        this.db = null;
    }

    // Initialize IndexedDB
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create books store
                if (!db.objectStoreNames.contains('books')) {
                    const booksStore = db.createObjectStore('books', { keyPath: 'id' });
                    booksStore.createIndex('title', 'title', { unique: false });
                    booksStore.createIndex('addedDate', 'addedDate', { unique: false });
                }
            };
        });
    }

    // Add a book to the database
    async addBook(bookData) {
        const tx = this.db.transaction(['books'], 'readwrite');
        const store = tx.objectStore('books');

        const book = {
            id: Date.now().toString(),
            title: bookData.title || 'Untitled Book',
            author: bookData.author || 'Unknown Author',
            fileType: bookData.fileType,
            fileData: bookData.fileData,
            addedDate: new Date().toISOString()
        };

        return new Promise((resolve, reject) => {
            const request = store.add(book);
            request.onsuccess = () => resolve(book);
            request.onerror = () => reject(request.error);
        });
    }

    // Get all books
    async getAllBooks() {
        const tx = this.db.transaction(['books'], 'readonly');
        const store = tx.objectStore('books');

        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // Get a specific book by ID
    async getBook(id) {
        const tx = this.db.transaction(['books'], 'readonly');
        const store = tx.objectStore('books');

        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // Delete a book
    async deleteBook(id) {
        const tx = this.db.transaction(['books'], 'readwrite');
        const store = tx.objectStore('books');

        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => {
                // Also delete related reading position
                this.deleteReadingPosition(id);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    // Save reading position to localStorage
    saveReadingPosition(bookId, position) {
        const positions = this.getAllReadingPositions();
        positions[bookId] = {
            ...position,
            lastRead: new Date().toISOString()
        };
        localStorage.setItem('readingPositions', JSON.stringify(positions));
    }

    // Get reading position for a book
    getReadingPosition(bookId) {
        const positions = this.getAllReadingPositions();
        return positions[bookId] || null;
    }

    // Get all reading positions
    getAllReadingPositions() {
        const data = localStorage.getItem('readingPositions');
        return data ? JSON.parse(data) : {};
    }

    // Delete reading position
    deleteReadingPosition(bookId) {
        const positions = this.getAllReadingPositions();
        delete positions[bookId];
        localStorage.setItem('readingPositions', JSON.stringify(positions));
    }

    // Save user settings to localStorage
    saveSettings(settings) {
        const currentSettings = this.getSettings();
        const updatedSettings = { ...currentSettings, ...settings };
        localStorage.setItem('appSettings', JSON.stringify(updatedSettings));
    }

    // Get user settings
    getSettings() {
        const data = localStorage.getItem('appSettings');
        return data ? JSON.parse(data) : {
            speed: 1.0,
            pitch: 0,
            voiceId: 'en-US-Neural2-A',
            theme: 'light',
            fontSize: 'medium'
        };
    }

    // Save usage statistics
    saveUsage(usage) {
        localStorage.setItem('ttsUsage', JSON.stringify(usage));
    }

    // Get usage statistics
    getUsage() {
        const data = localStorage.getItem('ttsUsage');
        const now = Date.now();
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

        return data ? JSON.parse(data) : {
            charactersUsed: 0,
            monthStart: monthStart,
            lastUpdated: now
        };
    }
}

// Create global storage manager instance
const storage = new StorageManager();
