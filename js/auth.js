/**
 * Authentication UI and logic
 */

class AuthManager {
    constructor() {
        this.isShowingAuth = false;
    }

    /**
     * Check if user is authenticated, show login if not
     */
    async requireAuth() {
        if (!ttsApi.isAuthenticated()) {
            return await this.showAuthModal();
        }
        return true;
    }

    /**
     * Show authentication modal
     */
    async showAuthModal() {
        return new Promise((resolve, reject) => {
            if (this.isShowingAuth) {
                return;
            }

            this.isShowingAuth = true;

            // Create modal
            const modal = document.createElement('div');
            modal.className = 'auth-modal';
            modal.innerHTML = `
                <div class="auth-modal-content">
                    <h2>Welcome to ReadAloud</h2>
                    <p class="auth-subtitle">Please login or create an account to use text-to-speech</p>

                    <div class="auth-tabs">
                        <button class="auth-tab active" data-tab="login">Login</button>
                        <button class="auth-tab" data-tab="register">Register</button>
                    </div>

                    <form id="auth-form" class="auth-form">
                        <div class="form-group">
                            <label for="auth-username">Username</label>
                            <input type="text" id="auth-username" class="form-input" required>
                        </div>
                        <div class="form-group">
                            <label for="auth-password">Password</label>
                            <input type="password" id="auth-password" class="form-input" required>
                        </div>
                        <div class="auth-error" id="auth-error"></div>
                        <button type="submit" class="auth-submit-btn" id="auth-submit">Login</button>
                    </form>
                </div>
            `;

            document.body.appendChild(modal);

            const form = modal.querySelector('#auth-form');
            const usernameInput = modal.querySelector('#auth-username');
            const passwordInput = modal.querySelector('#auth-password');
            const errorDiv = modal.querySelector('#auth-error');
            const submitBtn = modal.querySelector('#auth-submit');
            const tabs = modal.querySelectorAll('.auth-tab');

            let isLogin = true;

            // Tab switching
            tabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    tabs.forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');

                    isLogin = tab.dataset.tab === 'login';
                    submitBtn.textContent = isLogin ? 'Login' : 'Register';
                    errorDiv.textContent = '';
                });
            });

            // Form submission
            form.addEventListener('submit', async (e) => {
                e.preventDefault();

                const username = usernameInput.value.trim();
                const password = passwordInput.value;

                if (!username || !password) {
                    errorDiv.textContent = 'Please fill in all fields';
                    return;
                }

                if (password.length < 6) {
                    errorDiv.textContent = 'Password must be at least 6 characters';
                    return;
                }

                submitBtn.disabled = true;
                submitBtn.textContent = isLogin ? 'Logging in...' : 'Creating account...';
                errorDiv.textContent = '';

                try {
                    if (isLogin) {
                        await ttsApi.login(username, password);
                    } else {
                        await ttsApi.register(username, password);
                    }

                    // Success
                    modal.remove();
                    this.isShowingAuth = false;
                    resolve(true);
                } catch (error) {
                    errorDiv.textContent = error.message || 'Authentication failed';
                    submitBtn.disabled = false;
                    submitBtn.textContent = isLogin ? 'Login' : 'Register';
                }
            });

            // Focus username input
            setTimeout(() => usernameInput.focus(), 100);
        });
    }

    /**
     * Show logout confirmation
     */
    async logout() {
        if (confirm('Are you sure you want to logout?')) {
            ttsApi.logout();
            alert('You have been logged out. You will need to login again to use text-to-speech.');
            window.location.reload();
        }
    }
}

// Create global instance
const authManager = new AuthManager();
