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
            addedDate: new Date().toISOString(),
            syncedToBackend: false
        };

        return new Promise((resolve, reject) => {
            const request = store.add(book);
            request.onsuccess = async () => {
                // Sync book (including file data) to backend
                if (typeof ttsApi !== 'undefined' && ttsApi.isAuthenticated()) {
                    try {
                        // Convert fileData array to base64 (handle large files)
                        const uint8Array = new Uint8Array(book.fileData);
                        let binary = '';
                        const chunkSize = 8192;
                        for (let i = 0; i < uint8Array.length; i += chunkSize) {
                            const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
                            binary += String.fromCharCode.apply(null, chunk);
                        }
                        const base64Data = btoa(binary);

                        console.log(`Uploading book "${book.title}" (${Math.round(base64Data.length / 1024)}KB)`);

                        const result = await ttsApi.saveBook({
                            title: book.title,
                            author: book.author,
                            fileType: book.fileType,
                            uploadedAt: book.addedDate,
                            fileData: base64Data
                        });
                        book.syncedToBackend = true;
                        book.backendId = result.id;
                        console.log(`✅ Book uploaded successfully: "${book.title}"`);
                    } catch (error) {
                        console.error('Failed to sync book to backend:', error);
                        alert(`Failed to upload "${book.title}" to cloud: ${error.message}`);
                    }
                }
                resolve(book);
            };
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

    // Sync books from backend
    async syncBooksFromBackend() {
        if (typeof ttsApi === 'undefined' || !ttsApi.isAuthenticated()) {
            return; // Not authenticated, skip sync
        }

        try {
            // Get books from backend
            const backendBooks = await ttsApi.getBooks();
            const localBooks = await this.getAllBooks();

            // Create a map of local books by title+author for matching
            const localBookMap = {};
            localBooks.forEach(book => {
                const key = `${book.title}_${book.author}`;
                localBookMap[key] = book;
            });

            // Track which books from backend we found locally
            const syncedBookIds = new Set();

            // Check each backend book
            for (const backendBook of backendBooks) {
                const key = `${backendBook.title}_${backendBook.author}`;

                if (localBookMap[key]) {
                    // Book exists locally, mark it as synced
                    syncedBookIds.add(localBookMap[key].id);
                } else {
                    // Book exists in backend but not locally - download it!
                    console.log(`Downloading book from cloud: "${backendBook.title}"`);
                    try {
                        const bookData = await ttsApi.downloadBook(backendBook.id);

                        // Convert base64 to array
                        const binaryString = atob(bookData.fileData);
                        const bytes = new Uint8Array(binaryString.length);
                        for (let i = 0; i < binaryString.length; i++) {
                            bytes[i] = binaryString.charCodeAt(i);
                        }

                        // Add to local database
                        const tx2 = this.db.transaction(['books'], 'readwrite');
                        const store2 = tx2.objectStore('books');

                        const newBook = {
                            id: Date.now().toString() + Math.random(),
                            title: bookData.title,
                            author: bookData.author,
                            fileType: bookData.fileType,
                            fileData: Array.from(bytes),
                            addedDate: new Date().toISOString(),
                            syncedToBackend: true,
                            backendId: backendBook.id
                        };

                        store2.add(newBook);
                        console.log(`✅ Downloaded and restored book: "${backendBook.title}"`);
                    } catch (error) {
                        console.error(`Failed to download book "${backendBook.title}":`, error);
                    }
                }
            }

            // Mark local books that aren't synced yet
            const tx = this.db.transaction(['books'], 'readwrite');
            const store = tx.objectStore('books');

            for (const localBook of localBooks) {
                const key = `${localBook.title}_${localBook.author}`;
                const backendBook = backendBooks.find(b => `${b.title}_${b.author}` === key);

                if (backendBook && !localBook.syncedToBackend) {
                    // Update local book to mark as synced
                    localBook.syncedToBackend = true;
                    localBook.backendId = backendBook.id;
                    store.put(localBook);
                } else if (!backendBook && !localBook.syncedToBackend) {
                    // Local book not in backend, upload it
                    try {
                        const result = await ttsApi.saveBook({
                            title: localBook.title,
                            author: localBook.author,
                            fileType: localBook.fileType,
                            uploadedAt: localBook.addedDate
                        });
                        localBook.syncedToBackend = true;
                        localBook.backendId = result.id;
                        store.put(localBook);
                    } catch (error) {
                        console.error('Failed to sync book to backend:', error);
                    }
                }
            }

            await tx.complete;
            console.log('Book sync completed');
        } catch (error) {
            console.error('Failed to sync books from backend:', error);
        }
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
        // Get the book first to check if it's synced
        const book = await this.getBook(id);

        const tx = this.db.transaction(['books'], 'readwrite');
        const store = tx.objectStore('books');

        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = async () => {
                // Also delete related reading position
                this.deleteReadingPosition(id);

                // Delete from backend if synced
                if (book && book.backendId && typeof ttsApi !== 'undefined' && ttsApi.isAuthenticated()) {
                    try {
                        await ttsApi.deleteBook(book.backendId);
                    } catch (error) {
                        console.error('Failed to delete book from backend:', error);
                    }
                }

                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    // Save reading position to localStorage
    async saveReadingPosition(bookId, position) {
        const positions = this.getAllReadingPositions();
        positions[bookId] = {
            ...position,
            lastRead: new Date().toISOString()
        };
        localStorage.setItem('readingPositions', JSON.stringify(positions));

        // Sync to backend using backend book ID
        if (typeof ttsApi !== 'undefined' && ttsApi.isAuthenticated()) {
            try {
                const book = await this.getBook(bookId);
                if (book && book.backendId) {
                    // Build position data based on type
                    const positionData = {
                        bookId: book.backendId,  // Use backend ID for sync
                        type: position.type
                    };

                    // Add type-specific fields
                    if (position.type === 'epub' && position.cfi) {
                        positionData.cfi = position.cfi;
                        // Also include paragraphIndex for EPUB (for precise positioning within page)
                        if (position.paragraphIndex !== undefined) {
                            positionData.paragraphIndex = position.paragraphIndex;
                        }
                    } else if (position.type === 'pdf') {
                        positionData.paragraphIndex = position.paragraphIndex;
                        positionData.totalParagraphs = position.totalParagraphs;
                    }

                    await ttsApi.savePosition(positionData);
                }
            } catch (error) {
                console.error('Failed to sync position to backend:', error);
            }
        }
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
