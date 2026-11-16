// --- НАСТРОЙКИ API (бэкенд на Netrun) ---
        const API_BASE = 'https://shersh-auth.de1.netrun.io';

        // --- Токен входа: сервер верит только ему, не имени в запросе ---
        const TOKEN_KEY = 'shersh_token';

        function getToken() {
            try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
        }

        function setToken(token) {
            if (!token) return;
            try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* приватный режим */ }
        }

        function clearToken() {
            try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* приватный режим */ }
        }

        function clearSession() {
            try { localStorage.removeItem("shersh_user"); } catch (e) { /* приватный режим */ }
            clearToken();
        }

        function escapeHTML(str) {
            return String(str == null ? '' : str)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // Сжатие изображения на клиенте (уменьшает вес до ~1280px по ширине)
        const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // 12 МБ — до сжатия

        function validateImageFile(file) {
            if (!file) return 'Файл не выбран';
            if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type || '')) {
                return 'Можно загрузить только JPG, PNG, WEBP или GIF';
            }
            if (file.size > MAX_UPLOAD_BYTES) {
                return `Файл слишком большой (${(file.size / 1048576).toFixed(1)} МБ). Максимум 12 МБ`;
            }
            return null;
        }

        function compressImage(file, maxWidth = 1280, quality = 0.7) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => {
                        const scale = Math.min(1, maxWidth / img.width);
                        const w = Math.round(img.width * scale);
                        const h = Math.round(img.height * scale);
                        const canvas = document.createElement('canvas');
                        canvas.width = w; canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, w, h);
                        resolve(canvas.toDataURL('image/jpeg', quality));
                    };
                    img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
                    img.src = e.target.result;
                };
                reader.onerror = () => reject(new Error('Ошибка чтения файла'));
                reader.readAsDataURL(file);
            });
        }

        // Загрузка base64-изображения на сервер, возвращает URL в Storage
        async function uploadImage(base64Data) {
            const data = await api('/api/upload', {
                method: 'POST',
                body: JSON.stringify({ image: base64Data })
            });
            return data.url;
        }

        async function api(path, options = {}) {
            const attempts = 3;
            let lastErr = null;
            for (let i = 0; i < attempts; i++) {
                try {
                const res = await fetch(API_BASE + path, {
                    ...options,
                    headers: Object.assign(
                        { 'Content-Type': 'application/json' },
                        getToken() ? { Authorization: 'Bearer ' + getToken() } : {},
                        (options && options.headers) || {}
                    )
                });
                    const data = await res.json().catch(() => ({}));
                if (res.status === 401) {
                    // токен истёк или сессия устарела — просим войти заново
                    clearSession();
                }
                    if (!res.ok) {
                        // 5xx — сервер просыпается, пробуем ещё; 4xx — повторять бессмысленно
                        if (res.status >= 500 && i < attempts - 1) {
                            lastErr = new Error(data.error || ('Ошибка ' + res.status));
                            await new Promise(r => setTimeout(r, 800 * (i + 1)));
                            continue;
                        }
                        throw new Error(data.error || ('Ошибка ' + res.status));
                    }
                    return data;
                } catch (e) {
                    lastErr = e;
                    const isNet = /fetch|network|Failed|соединени|Соединени|таймаут|timeout/i.test(e.message || '');
                    if (i < attempts - 1 && (isNet || /Ошибка 5\d\d/.test(e.message || ''))) {
                        await new Promise(r => setTimeout(r, 800 * (i + 1)));
                        continue;
                    }
                    throw e;
                }
            }
            throw lastErr || new Error('Сеть недоступна');
        }

        let posts = [];
        let usersMap = {}; // name -> profile (для аватаров/ников)
        const POSTS_CACHE_KEY = 'shersh_posts_cache';

        // Извлечение тегов вида #тег из текста
        function extractTags(text) {
            const matches = String(text || '').match(/#([\wа-яёА-ЯЁ]+)/g) || [];
            const tags = [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
            return tags.slice(0, 6);
        }

        let activeTag = null; // активный фильтр по тегу

        async function loadPosts() {
            // Показываем скелетон только если нет кеша (первый заход)
            if (!localStorage.getItem(POSTS_CACHE_KEY)) showFeedSkeleton();
            // Сначала показываем кешированную ленту, если есть (работает даже когда сервер Netrun спит)
            const cached = localStorage.getItem(POSTS_CACHE_KEY);
            if (cached) {
                try {
                    posts = JSON.parse(cached);
                    renderPosts();
                } catch (e) {}
            }
            try {
                const rows = await api('/api/posts');
                posts = rows.map(r => ({
                    id: r.id, title: r.title, text: r.text, author: r.author,
                    date: r.date, image: r.image, likes: r.likes || 0,
                    comments: r.comments || [], isLiked: likedSet.has(r.id),
                    tags: extractTags(r.title + ' ' + r.text)
                }));
                localStorage.setItem(POSTS_CACHE_KEY, JSON.stringify(posts));
                renderPosts();
                updateBell();
            } catch (e) {
                if (localStorage.getItem(POSTS_CACHE_KEY)) {
                    showToast('Нет связи с сервером — показана сохранённая копия ⚠️', true);
                } else {
                    showToast('Не удалось загрузить истории: ' + e.message, true);
                }
            }
        }

        const PROFILES_CACHE_KEY = 'shersh_profiles_cache';

        async function loadProfiles() {
            // сначала поднимаем кеш — аватары не мигают, если сервер спит
            try {
                const cached = JSON.parse(localStorage.getItem(PROFILES_CACHE_KEY) || 'null');
                if (cached && typeof cached === 'object') {
                    Object.keys(cached).forEach(k => { usersMap[k] = cached[k]; });
                }
            } catch (e) {}
            try {
                const profiles = await api('/api/profiles');
                profiles.forEach(p => usersMap[p.name] = p);
                try {
                    const slim = {};
                    profiles.forEach(p => {
                        slim[p.name] = { name: p.name, nickname: p.nickname, avatar: p.avatar, bio: p.bio };
                    });
                    localStorage.setItem(PROFILES_CACHE_KEY, JSON.stringify(slim));
                } catch (e) {}
            } catch (e) { /* профили подтягиваются по мере необходимости */ }
        }

        // --- ГЛАЗИК ДЛЯ ПАРОЛЯ ---
        function togglePasswordVisibility(inputId, iconElement) {
            const input = document.getElementById(inputId);
            if (input.type === 'password') {
                input.type = 'text';
                iconElement.textContent = '🙈'; // Иконка "обезьянка закрывает глаза"
            } else {
                input.type = 'password';
                iconElement.textContent = '👁️';
            }
        }

        function switchAuthTab(tab) {
            const loginForm = document.getElementById('loginForm');
            const registerForm = document.getElementById('registerForm');
            const tabLogin = document.getElementById('tabLogin');
            const tabRegister = document.getElementById('tabRegister');

            if (tab === 'login') {
                loginForm.style.display = 'block'; registerForm.style.display = 'none';
                tabLogin.classList.remove('btn-cancel'); tabLogin.classList.add('btn');
                tabRegister.classList.remove('btn'); tabRegister.classList.add('btn-cancel');
            } else {
                loginForm.style.display = 'none'; registerForm.style.display = 'block';
                tabRegister.classList.remove('btn-cancel'); tabRegister.classList.add('btn');
                tabLogin.classList.remove('btn'); tabLogin.classList.add('btn-cancel');
            }
        }

        document.addEventListener('mousemove', (e) => {
            if (Math.random() > 0.4) return;
            const sparkle = document.createElement('div');
            sparkle.className = 'sparkle'; sparkle.innerHTML = '✦';
            sparkle.style.left = (e.clientX - 8) + 'px'; sparkle.style.top = (e.clientY - 8) + 'px';
            document.body.appendChild(sparkle);
            setTimeout(() => sparkle.remove(), 800);
        });

        document.addEventListener('click', (e) => {
            for (let i = 0; i < 6; i++) {
                const sparkle = document.createElement('div');
                sparkle.className = 'sparkle'; sparkle.innerHTML = '✦';
                const offsetX = (Math.random() - 0.5) * 80; const offsetY = (Math.random() - 0.5) * 80;
                sparkle.style.left = (e.clientX - 8) + 'px'; sparkle.style.top = (e.clientY - 8) + 'px';
                sparkle.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
                document.body.appendChild(sparkle);
                setTimeout(() => sparkle.remove(), 800);
            }
        });

        // Лоадер на время запроса
        async function withLoading(btn, fn) {
            if (!btn || btn.disabled) return;
            const original = btn.textContent;
            btn.disabled = true;
            btn.textContent = '⏳ Отправка...';
            try { return await fn(); }
            finally { btn.disabled = false; btn.textContent = original; }
        }

        function showToast(message, isError = false, kind = null) {
            const container = document.getElementById('toastContainer');
            if (!container) return;
            const type = kind || (isError ? 'error' : 'success');
            const icons = { success: '✅', error: '⚠️', info: 'ℹ️' };
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
            toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</span><span class="toast-text"></span>`;
            toast.querySelector('.toast-text').textContent = message;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.animation = 'slideIn 0.3s ease-in reverse forwards';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }

        // --- Свои окна вместо нативных alert/confirm/prompt ---
        function openUiDialog(opts) {
            const o = Object.assign({
                title: '', text: '', value: '', placeholder: '', inputLabel: '',
                multiline: false, hasInput: false, okText: 'OK', cancelText: 'Отмена',
                danger: false, requireText: null
            }, opts || {});

            return new Promise(resolve => {
                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay ui-dialog';
                overlay.style.display = 'flex';

                const box = document.createElement('div');
                box.className = 'modal-content';
                box.setAttribute('role', 'dialog');
                box.setAttribute('aria-modal', 'true');
                box.setAttribute('aria-label', o.title);

                const h = document.createElement('h2');
                h.style.textAlign = 'center';
                h.textContent = o.title;
                box.appendChild(h);

                if (o.text) {
                    const p = document.createElement('p');
                    p.className = 'ui-dialog-text';
                    p.textContent = o.text;
                    box.appendChild(p);
                }

                let field = null;
                const err = document.createElement('div');
                err.className = 'form-error';

                if (o.hasInput) {
                    if (o.inputLabel) {
                        const lbl = document.createElement('label');
                        lbl.textContent = o.inputLabel;
                        box.appendChild(lbl);
                    }
                    field = document.createElement(o.multiline ? 'textarea' : 'input');
                    if (o.multiline) { field.rows = 3; } else { field.type = 'text'; }
                    field.value = o.value || '';
                    field.placeholder = o.placeholder || '';
                    field.className = 'ui-dialog-input';
                    box.appendChild(field);
                    box.appendChild(err);
                }

                const btns = document.createElement('div');
                btns.className = 'modal-buttons';

                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'btn btn-cancel';
                cancelBtn.textContent = o.cancelText;

                const okBtn = document.createElement('button');
                okBtn.type = 'button';
                okBtn.className = 'btn' + (o.danger ? ' btn-delete' : '');
                okBtn.textContent = o.okText;

                btns.appendChild(cancelBtn);
                btns.appendChild(okBtn);
                box.appendChild(btns);
                overlay.appendChild(box);
                document.body.appendChild(overlay);
                if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();

                const close = (result) => {
                    overlay.remove();
                    document.removeEventListener('keydown', onKey, true);
                    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
                    resolve(result);
                };
                const fail = (m) => { err.textContent = m; err.style.display = 'block'; };

                const accept = () => {
                    if (!field) return close(true);
                    const v = field.value;
                    if (o.requireText !== null && (v || '').trim().toUpperCase() !== o.requireText.toUpperCase()) {
                        return fail('Введите «' + o.requireText + '» — иначе действие отменится');
                    }
                    return close(v);
                };

                const onKey = (e) => {
                    if (e.key === 'Escape') { e.preventDefault(); close(o.hasInput ? null : false); }
                    else if (e.key === 'Enter' && (!field || !o.multiline)) { e.preventDefault(); accept(); }
                };

                okBtn.addEventListener('click', accept);
                cancelBtn.addEventListener('click', () => close(o.hasInput ? null : false));
                overlay.addEventListener('click', (e) => { if (e.target === overlay) close(o.hasInput ? null : false); });
                document.addEventListener('keydown', onKey, true);

                setTimeout(() => { (field || okBtn).focus(); if (field && field.select) field.select(); }, 30);
            });
        }

        function uiConfirm(title, text, opts) {
            return openUiDialog(Object.assign({ title, text, okText: 'Подтвердить' }, opts || {}));
        }

        function uiPrompt(title, opts) {
            return openUiDialog(Object.assign({ title, hasInput: true, okText: 'Сохранить' }, opts || {}));
        }

        function openImageModal(src) {
            document.getElementById('fullImage').src = src;
            document.getElementById('imageModal').style.display = 'flex';
        }

        function closeImageModal() {
            document.getElementById('imageModal').style.display = 'none';
        }

        function insertHint(text) {
            const textarea = document.getElementById('postText');
            textarea.value = text + textarea.value; textarea.focus(); updateWordCount();
        }

        function updateWordCount() {
            const text = document.getElementById('postText').value.trim();
            const wordCount = text ? text.split(/\s+/).length : 0;
            document.getElementById('wordCount').textContent = `Слов: ${wordCount} · Символов: ${text.length}`;
        }

        // Сессия: только для запоминания, кто залогинен (не источник данных)
        let userData = JSON.parse(localStorage.getItem('shersh_user')) || {
            name: '', nickname: '', bio: '', avatar: '', isGuest: false, is_admin: false
        };

        let likedSet = new Set();

        function persistUser() {
            localStorage.setItem('shersh_user', JSON.stringify(userData));
            updateHeaderUI(); updateProfileUI();
            if (userData.name && !userData.isGuest) updateLikedSet();
        }

        const loginModal = document.getElementById('loginModal');
        const editProfileModal = document.getElementById('editProfileModal');
        const postModal = document.getElementById('postModal');
        const deleteAccountModal = document.getElementById('deleteAccountModal');
        let editingPostId = null;
        let currentPostImageBase64 = null;
        let currentCommentImageBase64 = null;

        function checkAuth() {
            if (!userData.name && !userData.isGuest) {
                loginModal.style.display = 'flex';
            } else {
                updateHeaderUI();
                if (userData.name && !userData.isGuest) checkBan();
            }
        }

        // Если пользователь забанен — показываем сообщение и выходим из аккаунта
        async function checkBan() {
            try {
                const r = await api('/api/ban/check?name=' + encodeURIComponent(userData.name));
                if (r.banned) {
                    showToast('Ваш аккаунт заблокирован модератором', true);
                    clearSession();
                    setTimeout(() => location.reload(), 1500);
                }
            } catch (e) { /* сервер спит — игнорируем */ }
        }

        document.getElementById('registerBtn').addEventListener('click', async () => {
            const name = document.getElementById('regNameInput').value.trim();
            const nick = document.getElementById('regNickInput').value.trim();
            const pass = document.getElementById('regPassInput').value.trim();

            if (!name || !nick || !pass) { showToast('Заполни все поля!', true); return; }

            try {
                const data = await api('/api/register', { method: 'POST', body: JSON.stringify({ name, nickname: nick, password: pass }) });
                userData = { name: data.user.name, nickname: data.user.nickname, bio: '', avatar: '', is_admin: !!data.user.is_admin };
                setToken(data.token);
                persistUser(); loginModal.style.display = 'none';
                showToast(`Добро пожаловать, ${name}!`);
            } catch (e) { showToast(e.message, true); }
        });

        document.getElementById('loginBtn').addEventListener('click', async () => {
            const name = document.getElementById('loginNameInput').value.trim();
            const pass = document.getElementById('loginPassInput').value.trim();

            if (!name || !pass) { showToast('Введи имя и пароль!', true); return; }
            try {
                const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ name, password: pass }) });
                userData = { name: data.user.name, nickname: data.user.nickname, bio: data.user.bio, avatar: data.user.avatar, is_admin: !!data.user.is_admin };
                setToken(data.token);
                persistUser(); loginModal.style.display = 'none';
                showToast(`С возвращением, ${userData.name}!`);
            } catch (e) { showToast(e.message, true); }
        });

        // --- Восстановление пароля через Telegram ---
        const forgotForm = document.getElementById('forgotForm');
        const loginForm2 = document.getElementById('loginForm');

        document.getElementById('forgotPassBtn').addEventListener('click', () => {
            loginForm2.style.display = 'none';
            forgotForm.style.display = 'block';
        });

        document.getElementById('forgotBackBtn').addEventListener('click', () => {
            forgotForm.style.display = 'none';
            loginForm2.style.display = 'block';
        });

        document.getElementById('forgotStep1Btn').addEventListener('click', async () => {
            const name = document.getElementById('forgotNameInput').value.trim();
            if (!name) { showToast('Введи имя', true); return; }
            try {
                await api('/api/forgot-password', { method: 'POST', body: JSON.stringify({ name }) });
                document.getElementById('forgotStep1Btn').style.display = 'none';
                document.getElementById('forgotStep2Btn').style.display = 'inline-block';
                showToast('Код отправлен в ваш Telegram!');
            } catch (e) { showToast(e.message, true); }
        });

        document.getElementById('forgotStep2Btn').addEventListener('click', async () => {
            const code = document.getElementById('forgotCodeInput').value.trim();
            const newPass = document.getElementById('forgotNewPassInput').value.trim();
            if (!code || !newPass) { showToast('Введи код и новый пароль', true); return; }
            try {
                await api('/api/reset-password', { method: 'POST', body: JSON.stringify({ code, new_password: newPass }) });
                showToast('Пароль изменён! Войдите с новым паролем');
                forgotForm.style.display = 'none';
                loginForm2.style.display = 'block';
                document.getElementById('forgotStep1Btn').style.display = 'inline-block';
                document.getElementById('forgotStep2Btn').style.display = 'none';
            } catch (e) { showToast(e.message, true); }
        });

        document.getElementById('guestBtn').addEventListener('click', () => {
            userData = { name: 'Гость', nickname: '@guest', bio: 'Просто зашел посмотреть', avatar: '', isGuest: true };
            persistUser(); loginModal.style.display = 'none';
            showToast('Вы вошли как Гость');
        });

        const botUsername = "Shersh_authbot";
        let checkInterval = null;

        document.getElementById('telegramBotBtn').addEventListener('click', () => {
            const code = Math.random().toString(36).substring(2, 10);
            window.open(`https://t.me/${botUsername}?start=${code}`, '_blank');
            document.getElementById('waitingMsg').style.display = 'block';

            checkInterval = setInterval(() => {
                fetch(`https://shersh-auth.de1.netrun.io/check_auth?code=${code}`)
                    .then(res => res.json())
                    .then(data => {
                        if (data.status === 'ok') {
                            clearInterval(checkInterval);
                            document.getElementById('waitingMsg').style.display = 'none';
                            userData.name = data.user.first_name;
                            userData.nickname = '@' + (data.user.username || 'user');
                            // привязываем telegram_id к профилю (для восстановления пароля)
                            if (data.user.id) {
                                fetch(API_BASE + '/api/telegram-bind', {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ name: userData.name, telegram_id: String(data.user.id) })
                                }).catch(() => {});
                            }
                            persistUser();
                            loginModal.style.display = 'none';
                            showToast(`Добро пожаловать, ${data.user.first_name}!`);
                            setTimeout(() => location.reload(), 1000);
                        }
                    }).catch(err => console.error("Ошибка проверки:", err));
            }, 2000);
        });

        function updateHeaderUI() {
            const btn = document.getElementById('headerProfileBtn');
            btn.textContent = userData.name ? `👋 ${userData.name}` : '👋 Гость';

            const logoutBtn = document.getElementById('headerLogoutBtn');
            if (userData.name && !userData.isGuest) {
                logoutBtn.style.display = 'block';
            } else {
                logoutBtn.style.display = 'none';
            }

            // Кнопка админ-панели видна только администратору
            const adminBtn = document.getElementById('adminPanelBtn');
            if (adminBtn) {
                adminBtn.style.display = (userData.name && !userData.isGuest && userData.is_admin) ? 'block' : 'none';
            }

            // Колокольчик уведомлений виден только залогиненным
            const bellBtn = document.getElementById('bellBtn');
            const bellBadge = document.getElementById('bellBadge');
            if (userData.name && !userData.isGuest) {
                bellBtn.style.display = 'inline-block';
                updateBell();
            } else {
                bellBtn.style.display = 'none';
                bellBadge.style.display = 'none';
            }
            
            const searchContainer = document.getElementById('searchContainer');
            if (document.getElementById('profile-page').style.display === 'block' || document.getElementById('other-profile-page').style.display === 'block') {
                searchContainer.style.display = 'none';
            } else { searchContainer.style.display = 'block'; }
        }

        function showPage(page) {
            document.getElementById('feed-page').style.display = page === 'feed' ? 'block' : 'none';
            document.getElementById('profile-page').style.display = page === 'profile' ? 'block' : 'none';
            document.getElementById('other-profile-page').style.display = page === 'other' ? 'block' : 'none';
            updateHeaderUI();
            if (page === 'profile') updateProfileUI();
        }

        function updateProfileUI() {
            document.getElementById('profileNameDisplay').textContent = userData.name;
            document.getElementById('profileNickDisplay').textContent = userData.nickname;
            document.getElementById('profileBioDisplay').textContent = userData.bio || 'О себе пока ничего не написано...';
            
            const avatarImg = document.getElementById('avatarImage');
            const avatarPlaceholder = document.getElementById('avatarPlaceholder');
            
            if (userData.avatar) {
                avatarImg.src = userData.avatar; avatarImg.style.display = 'block'; avatarPlaceholder.style.display = 'none';
            } else {
                avatarImg.style.display = 'none'; avatarPlaceholder.style.display = 'flex';
            }

            let myPosts = posts.filter(p => p.author === userData.name);
            let totalLikes = myPosts.reduce((sum, p) => sum + p.likes, 0);
            let totalComments = myPosts.reduce((sum, p) => sum + (p.comments ? p.comments.length : 0), 0);
            document.getElementById('statPosts').textContent = myPosts.length;
            document.getElementById('statLikes').textContent = totalLikes;
            document.getElementById('statComments').textContent = totalComments;

            renderMyPosts(myPosts);

            // показываем, привязан ли Telegram (для восстановления пароля)
            if (typeof updateTelegramStatus === 'function') updateTelegramStatus();
        }

        function renderMyPosts(myPosts) {
            const list = document.getElementById('myPostsList');
            const countEl = document.getElementById('myPostsCount');
            if (!list) return;
            if (countEl) countEl.textContent = myPosts.length ? `(${myPosts.length})` : '';
            if (!myPosts.length) {
                list.innerHTML = '<p style="opacity:.7">Ты пока не написал ни одной истории.</p>';
                return;
            }
            list.innerHTML = myPosts.map(p => `
                <div class="my-post-row">
                    <a href="#" class="my-post-title" onclick='scrollToPost(${p.id}); return false;'>${escapeHTML(p.title)}</a>
                    <span class="my-post-meta">${formatDate(p.date)} · 👍 ${p.likes} · 💬 ${p.comments ? p.comments.length : 0}</span>
                </div>
            `).join('');
        }

        window.scrollToPost = function(id) {
            showPage('feed');
            const el = document.getElementById('post-' + id);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('flash');
                setTimeout(() => el.classList.remove('flash'), 1600);
            } else {
                showToast('История есть дальше в ленте — прокрути или нажми «Показать ещё»');
            }
        };

        window.openAuthorProfile = function(authorName) {
            const author = usersMap[authorName];

            document.getElementById('otherProfileNameDisplay').textContent = authorName;
            document.getElementById('otherProfileNickDisplay').textContent = author && author.nickname ? author.nickname : '@unknown';
            document.getElementById('otherProfileBioDisplay').textContent = author && author.bio ? author.bio : 'О себе пока ничего не написано...';

            const avatarImg = document.getElementById('otherAvatarImage');
            const avatarPlaceholder = document.getElementById('otherAvatarPlaceholder');
            
            if (author && author.avatar) {
                avatarImg.src = author.avatar; avatarImg.style.display = 'block'; avatarPlaceholder.style.display = 'none';
            } else {
                avatarImg.style.display = 'none'; avatarPlaceholder.style.display = 'flex';
            }

            const authorPosts = posts.filter(p => p.author === authorName);
            const totalLikes = authorPosts.reduce((sum, p) => sum + p.likes, 0);
            
            document.getElementById('otherStatPosts').textContent = authorPosts.length;
            document.getElementById('otherStatLikes').textContent = totalLikes;

            // Кнопка бана видна только админу и не для самого себя
            window.__currentProfileName = authorName;
            const banBtn = document.getElementById('banUserBtn');
            if (userData.is_admin && authorName !== userData.name) {
                banBtn.style.display = 'inline-block';
            } else {
                banBtn.style.display = 'none';
            }

            showPage('other');
        };

        // Бан/разбан пользователя (только админ)
        window.banUser = async function() {
            const target = window.__currentProfileName;
            if (!target) return;
            const ok = await uiConfirm('Забанить пользователя?', target + ' больше не сможет писать на сайте.', { okText: 'Забанить', danger: true });
            if (!ok) return;
            try {
                await api('/api/ban', { method: 'POST', body: JSON.stringify({ user: userData.name, target }) });
                showToast('Пользователь ' + target + ' забанен');
            } catch (e) { showToast(e.message, true); }
        };

        document.getElementById('avatarInput').addEventListener('change', async function(e) {
            const file = e.target.files[0];
            if (!file) return;
            const vErr = validateImageFile(file);
            if (vErr) { showToast(vErr, true); e.target.value = ''; return; }
            try {
                const b64 = await compressImage(file, 400, 0.7);
                const url = await uploadImage(b64);
                userData.avatar = url;
                await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ old_name: userData.name, avatar: url }) });
                persistUser(); showToast('Аватар обновлен!');
            } catch (err) { showToast(err.message, true); }
        });

        window.openEditProfile = function(focusField) {
            document.getElementById('editNameInput').value = userData.name;
            document.getElementById('editNicknameInput').value = userData.nickname;
            document.getElementById('editBioInput').value = userData.bio;
            document.getElementById('editNameError').style.display = 'none';
            document.getElementById('editNickError').style.display = 'none';
            editProfileModal.style.display = 'flex';
            if (focusField === 'name') document.getElementById('editNameInput').focus();
            if (focusField === 'nick') document.getElementById('editNicknameInput').focus();
        };

        document.getElementById('editProfileBtn').addEventListener('click', () => openEditProfile(null));
        document.getElementById('cancelEditBtn').addEventListener('click', () => editProfileModal.style.display = 'none');

        document.getElementById('saveEditBtn').addEventListener('click', async () => {
            let newName = document.getElementById('editNameInput').value.trim();
            let newNick = document.getElementById('editNicknameInput').value.trim();
            let newBio = document.getElementById('editBioInput').value.trim();

            if (newNick && !newNick.startsWith('@')) newNick = '@' + newNick;

            try {
                await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ old_name: userData.name, name: newName, nickname: newNick, bio: newBio }) });
                userData.name = newName; userData.nickname = newNick; userData.bio = newBio;
                usersMap[newName] = { name: newName, nickname: newNick, bio: newBio, avatar: userData.avatar };
                persistUser(); editProfileModal.style.display = 'none';
                showToast('Профиль успешно обновлен!');
            } catch (e) { showToast(e.message, true); }
        });

        document.getElementById('logoutBtn').addEventListener('click', () => { clearSession(); location.reload(); });
        document.getElementById('headerLogoutBtn').addEventListener('click', () => { clearSession(); location.reload(); });

        // Общий выход из ситуации «сервер не знает такого профиля» (устаревшая сессия)
        function handleStaleProfile(message) {
            if (!/не найден/i.test(String(message || ''))) return false;
            clearSession();
            localStorage.removeItem('shersh_seen_comments');
            showToast('Профиль не найден — сессия устарела. Войдите заново', true);
            setTimeout(() => location.reload(), 1600);
            return true;
        }

        // --- Смена пароля: нормальное окно вместо нативных prompt ---
        const passwordModal = document.getElementById('passwordModal');

        function openPasswordModal() {
            document.getElementById('oldPassInput').value = '';
            document.getElementById('newPassInput').value = '';
            document.getElementById('newPassRepeatInput').value = '';
            const err = document.getElementById('passModalError');
            err.textContent = ''; err.style.display = 'none';
            passwordModal.style.display = 'flex';
            if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
            document.getElementById('oldPassInput').focus();
        }

        function closePasswordModal() {
            passwordModal.style.display = 'none';
            if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
        }

        document.getElementById('changePassBtn').addEventListener('click', () => {
            if (!userData.name || userData.isGuest) { showToast('Войди в аккаунт', true); return; }
            openPasswordModal();
        });

        document.getElementById('cancelPassBtn').addEventListener('click', closePasswordModal);

        async function submitPasswordChange() {
            const oldP = document.getElementById('oldPassInput').value;
            const newP = document.getElementById('newPassInput').value.trim();
            const rep = document.getElementById('newPassRepeatInput').value.trim();
            const err = document.getElementById('passModalError');
            const fail = (m) => { err.textContent = m; err.style.display = 'block'; };

            err.style.display = 'none';
            if (!oldP) return fail('Введите текущий пароль');
            if (newP.length < 4) return fail('Новый пароль — минимум 4 символа');
            if (newP.length > 64) return fail('Новый пароль — не длиннее 64 символов');
            if (newP !== rep) return fail('Пароли не совпадают');
            if (newP === oldP) return fail('Новый пароль совпадает с текущим');

            const btn = document.getElementById('savePassBtn');
            try {
                await withLoading(btn, () => api('/api/password', {
                    method: 'POST',
                    body: JSON.stringify({ name: userData.name, old_password: oldP, new_password: newP })
                }));
                closePasswordModal();
                showToast('Пароль обновлён!');
            } catch (e) {
                if (handleStaleProfile(e.message)) return;
                fail(e.message || 'Не удалось сменить пароль');
            }
        }

        document.getElementById('savePassBtn').addEventListener('click', submitPasswordChange);
        document.getElementById('newPassRepeatInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitPasswordChange(); }
        });

        // --- Статус привязки Telegram в профиле ---
        let tgPollTimer = null;

        function stopTgPolling() {
            if (tgPollTimer) { clearInterval(tgPollTimer); tgPollTimer = null; }
        }

        async function updateTelegramStatus() {
            const el = document.getElementById('telegramStatus');
            const btn = document.getElementById('bindTelegramBtn');
            if (!el) return;
            if (!userData.name || userData.isGuest) { el.style.display = 'none'; return; }
            try {
                const data = await api('/api/telegram/status?name=' + encodeURIComponent(userData.name));
                if (data.bound) {
                    el.textContent = '✅ Telegram привязан — код восстановления пароля придёт в него.';
                    el.className = 'telegram-status ok';
                    if (btn) btn.textContent = '🔁 Перепривязать Telegram';
                    stopTgPolling();
                } else {
                    el.textContent = '⚠️ Telegram не привязан. Без него не работает восстановление пароля — нажми «Привязать Telegram», а в боте «Старт».';
                    el.className = 'telegram-status warn';
                    if (btn) btn.textContent = '📨 Привязать Telegram';
                }
                el.style.display = 'block';
            } catch (e) {
                el.style.display = 'none';
            }
        }
        window.updateTelegramStatus = updateTelegramStatus;

        function startTgPolling() {
            stopTgPolling();
            let tries = 0;
            tgPollTimer = setInterval(async () => {
                tries++;
                await updateTelegramStatus();
                const el = document.getElementById('telegramStatus');
                if ((el && el.classList.contains('ok')) || tries >= 20) stopTgPolling();
            }, 3000);
        }

        // Привязка Telegram: открываем бота с payload bind_<имя>
        document.getElementById('bindTelegramBtn').addEventListener('click', async () => {
            if (!userData.name || userData.isGuest) { showToast('Войди в аккаунт', true); return; }

            // окно открываем сразу, пока есть пользовательский жест (иначе блокировщик всплывающих)
            const win = window.open('', '_blank');
            try {
                const data = await api('/api/telegram/bind-code', {
                    method: 'POST', body: JSON.stringify({ name: userData.name })
                });
                const url = 'https://t.me/Shersh_authbot?start=b_' + encodeURIComponent(data.code);
                if (win) win.location = url; else window.open(url, '_blank');
                showToast('Открой бота и нажми «Старт» — привязка произойдёт автоматически');
                startTgPolling();
            } catch (e) {
                if (win) win.close();
                if (handleStaleProfile(e.message)) return;
                showToast(e.message, true);
            }
        });

        // Вернулись из Telegram — сразу перечитываем статус
        window.addEventListener('focus', () => {
            if (userData.name && !userData.isGuest) updateTelegramStatus();
        });

        document.getElementById('deleteAccountBtn').addEventListener('click', () => { deleteAccountModal.style.display = 'flex'; });
        document.getElementById('cancelDeleteBtn').addEventListener('click', () => { deleteAccountModal.style.display = 'none'; });
        document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
            try {
                await api('/api/profile', { method: 'DELETE', body: JSON.stringify({ name: userData.name }) });
                clearSession(); deleteAccountModal.style.display = 'none';
                showToast('Аккаунт удален'); setTimeout(() => location.reload(), 1500);
            } catch (e) { showToast(e.message, true); }
        });

        // Полное удаление всех своих данных
        document.getElementById('deleteAllDataBtn').addEventListener('click', async () => {
            if (!userData.name || userData.isGuest) { showToast('Войди в аккаунт', true); return; }
            const typed = await uiPrompt('Удалить всё безвозвратно?', {
                text: 'Профиль, все твои истории, комментарии и лайки будут удалены. Это необратимо.',
                inputLabel: 'Введите слово УДАЛИТЬ для подтверждения:',
                placeholder: 'УДАЛИТЬ',
                okText: 'Удалить навсегда',
                danger: true,
                requireText: 'УДАЛИТЬ'
            });
            if (typed === null) { showToast('Удаление отменено', false, 'info'); return; }
            try {
                let res = null;
                let usedFallback = false;
                try {
                    res = await api('/api/profile/full', { method: 'DELETE', body: JSON.stringify({ name: userData.name }) });
                } catch (e) {
                    // старый бэкенд без /api/profile/full — удаляем поштучно
                    if (/405|404|Не найден|Ошибка 4/i.test(e.message || '')) {
                        usedFallback = true;
                        const mine = posts.filter(p => p.author === userData.name);
                        for (const p of mine) {
                            try {
                                await api('/api/posts/' + p.id, { method: 'DELETE', body: JSON.stringify({ user: userData.name }) });
                            } catch (err) { /* пропускаем, чтобы не прервать очистку */ }
                        }
                        await api('/api/profile', { method: 'DELETE', body: JSON.stringify({ name: userData.name }) });
                        res = { removed: { posts: mine.length } };
                    } else {
                        throw e;
                    }
                }
                clearSession();
                localStorage.removeItem(POSTS_CACHE_KEY);
                localStorage.removeItem('shersh_post_draft');
                const rem = res && res.removed ? res.removed : null;
                showToast(rem ? `Удалено. Историй: ${rem.posts || 0}${usedFallback ? ' (частично)' : ''}` : 'Все данные удалены');
                setTimeout(() => location.reload(), 1600);
            } catch (e) { showToast(e.message, true); }
        });

        const themeSelect = document.getElementById('themeSelect');
        const body = document.body;
        // применяем сохранённую тему
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const savedTheme = localStorage.getItem('theme') || (prefersDark ? 'dark' : 'light');
        if (savedTheme !== 'light') body.setAttribute('data-theme', savedTheme);
        themeSelect.value = savedTheme;
        themeSelect.addEventListener('change', () => {
            const val = themeSelect.value;
            if (val === 'light') {
                body.removeAttribute('data-theme');
            } else {
                body.setAttribute('data-theme', val);
            }
            localStorage.setItem('theme', val);
        });

        // --- Счётчик «новых» комментариев ---
        const SEEN_COMMENTS_KEY = 'shersh_seen_comments';

        function getSeenComments() {
            try { return JSON.parse(localStorage.getItem(SEEN_COMMENTS_KEY) || '{}') || {}; }
            catch (e) { return {}; }
        }

        function markCommentsSeen(postId, count) {
            const seen = getSeenComments();
            seen[String(postId)] = count;
            try { localStorage.setItem(SEEN_COMMENTS_KEY, JSON.stringify(seen)); } catch (e) {}
        }

        function newCommentsBadge(post, commentCount) {
            if (!userData.name || userData.isGuest) return '';
            const seen = getSeenComments();
            const prev = seen[String(post.id)];
            if (prev === undefined) return ''; // пост ещё не открывали — не шумим
            const diff = commentCount - Number(prev || 0);
            if (diff <= 0) return '';
            return ` <span class="new-comments-badge" title="Новые комментарии с прошлого просмотра">+${diff}</span>`;
        }

        function formatDate(dateString) {
            const date = new Date(dateString);
            const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
            const hh = String(date.getHours()).padStart(2, '0'); const mm = String(date.getMinutes()).padStart(2, '0');
            return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} в ${hh}:${mm}`;
        }

        const postsContainer = document.getElementById('posts-container');

        function showFeedSkeleton() {
            postsContainer.innerHTML = `
                <div class="skeleton-card"><div class="skeleton-line title"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>
                <div class="skeleton-card"><div class="skeleton-line title"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>
                <div class="skeleton-card"><div class="skeleton-line title"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>
            `;
        }

        let postsPerPage = 5;      // сколько постов показывать за раз
        let visibleCount = postsPerPage;
        let myOnly = false;        // фильтр «только мои истории»

        function showMorePosts() {
            visibleCount += postsPerPage;
            renderPosts();
        }

        function renderPosts() {
            postsContainer.innerHTML = '';
            
            if (posts.length === 0) {
                postsContainer.innerHTML = `
                    <div class="empty-feed">
                        <h3>Здесь пока пусто...</h3>
                        <p>Стань первым, кто расскажет сказку Шершу!</p>
                        <button class="btn" onclick="document.getElementById('addPostBtn').click()">Добавить историю</button>
                    </div>
                `;
                return;
            }

            // не мутируем visibleCount: иначе лента «застревает» на старом числе записей
            const limit = Math.min(visibleCount, posts.length);

            let shown = 0;
            posts.slice(0, limit).forEach((post, index) => {
                // фильтр по активному тегу
                if (activeTag && !(post.tags && post.tags.includes(activeTag))) return;
                // фильтр «только мои истории»
                if (myOnly && post.author !== userData.name) return;
                shown++;
                const postElement = document.createElement('article');
                postElement.className = 'post-card';
                postElement.id = 'post-' + post.id;
                postElement.dataset.author = post.author || '';
                postElement.dataset.tags = (post.tags || []).join(' ');
                postElement.dataset.title = post.title || '';
                postElement.dataset.text = post.text || '';
                const dateStr = formatDate(post.date);
                const commentCount = post.comments ? post.comments.length : 0;
                
                const authorData = usersMap[post.author];
                const avatarSrc = authorData && authorData.avatar ? authorData.avatar : null;
                const escAuthor = escapeHTML(post.author);
                const avatarHTML = avatarSrc 
                    ? `<img src="${avatarSrc}" class="post-avatar" alt="Аватар ${escapeHTML(post.author)}" onclick='openAuthorProfile(&quot;${escapeHTML(post.author)}&quot;)'>` 
                    : `<div class="post-avatar" onclick='openAuthorProfile(&quot;${escapeHTML(post.author)}&quot;)'>👤</div>`;

                const isAuthor = userData.name === post.author && !userData.isGuest;
                const canDelete = isAuthor || userData.is_admin;
                const controlsHTML = `
                    <div class="post-controls">
                        ${isAuthor ? `<button class="edit-post-btn" onclick="editPost(${post.id})" title="Редактировать" aria-label="Редактировать историю">✏️</button>` : ''}
                        ${canDelete ? `<button class="delete-post-btn" onclick="deletePost(${post.id})" title="${userData.is_admin && !isAuthor ? 'Удалить (админ)' : 'Удалить'}" aria-label="Удалить историю">🗑️</button>` : ''}
                    </div>
                `;

                const imageHTML = post.image ? `<img src="${post.image}" class="post-image" alt="Изображение к истории «${escapeHTML(post.title)}»" loading="lazy" onclick="openImageModal('${post.image}')">` : '';
                const tagsHTML = (post.tags && post.tags.length)
                    ? `<div class="post-tags">${post.tags.map(t => `<span class="hint-tag" onclick="filterByTag('${escapeHTML(t)}')">#${escapeHTML(t)}</span>`).join('')}</div>`
                    : '';

                postElement.innerHTML = `
                    <div class="post-header-row">
                        <h2>${escapeHTML(post.title)}</h2>
                        ${controlsHTML}
                    </div>                    <div class="post-meta">
                        ${avatarHTML}
                        <span>Автор: <a href="#" class="author-name" onclick='openAuthorProfile(&quot;${escapeHTML(post.author)}&quot;)'>${escAuthor}</a></span>
                        <span>•</span>
                        <span>${dateStr}</span>
                        <span>•</span>
                        <span title="Примерное время чтения">⏱ ${readingTime(post.text)}</span>
                        <button class="action-btn" onclick="copyPostLink(${post.id})" title="Копировать ссылку на пост" aria-label="Копировать ссылку на пост" style="padding:0;font-size:0.85rem;">🔗</button>
                    </div>
                    ${imageHTML}
                    <div class="post-content"><p>${escapeHTML(post.text)}</p></div>
                    ${tagsHTML}
                    <div class="post-actions">
                        <button class="action-btn ${post.isLiked ? 'liked' : ''}" onclick="toggleLike(${index})">
                            👍 Нравится (<span>${post.likes}</span>)
                        </button>
                        <button class="action-btn" onclick="openComments(${index})">
                            💬 Комментарии (${commentCount})${newCommentsBadge(post, commentCount)}
                        </button>
                        <button class="action-btn" onclick="sharePost(${index})" title="Поделиться">
                            🔗 Поделиться
                        </button>
                        <button class="action-btn" onclick="speakPost(${index})" title="Слушать сказку" aria-label="Слушать сказку">
                            🔊 Слушать
                        </button>
                        ${!userData.isGuest && userData.name ? `<button class="action-btn" onclick="reportPost(${post.id})" title="Пожаловаться" aria-label="Пожаловаться на историю">🚩</button>` : ''}
                    </div>
                `;
                postsContainer.appendChild(postElement);
            });

            if (visibleCount < posts.length) {
                const moreBtn = document.createElement('button');
                moreBtn.className = 'btn';
                moreBtn.textContent = 'Показать ещё (' + (posts.length - visibleCount) + ')';
                moreBtn.style.display = 'block';
                moreBtn.style.margin = '0 auto 20px';
                moreBtn.onclick = showMorePosts;
                postsContainer.appendChild(moreBtn);
            }

            // после перерисовки ленты сохраняем активный поиск
            const searchEl = document.getElementById('searchInput');
            if (searchEl && searchEl.value.trim()) filterPosts(true);
        }

        let searchTimer = null;
        function onSearchInput() {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => filterPosts(true), 250);
        }

        function normalizeForSearch(s) {
            return String(s || '').toLowerCase().replace(/ё/g, 'е');
        }

        function filterPosts(allowHighlight) {
            const raw = document.getElementById('searchInput').value.trim();
            const query = normalizeForSearch(raw);
            const postCards = document.querySelectorAll('.post-card');
            let visible = 0;
            postCards.forEach(card => {
                const haystack = normalizeForSearch([
                    card.dataset.title,
                    card.dataset.text,
                    card.dataset.author,
                    card.dataset.tags
                ].join(' '));
                const match = !query || haystack.includes(query);
                card.style.display = match ? 'block' : 'none';
                if (match) visible++;
                if (allowHighlight) highlightInCard(card, raw);
            });
            updateSearchStatus(query ? visible : null, raw);
        }

        function updateSearchStatus(count, raw) {
            let el = document.getElementById('searchStatus');
            if (!el) {
                el = document.createElement('div');
                el.id = 'searchStatus';
                el.className = 'search-status';
                const bar = document.getElementById('searchContainer');
                if (bar) bar.appendChild(el);
            }
            if (count === null) { el.textContent = ''; el.style.display = 'none'; return; }
            el.style.display = 'block';
            el.textContent = count > 0
                ? `Найдено историй: ${count} по запросу «${raw}»`
                : `По запросу «${raw}» ничего не найдено`;
        }

        // Подсветка совпадений в заголовке, тексте, авторе и тегах
        function highlightInCard(card, raw) {
            const q = String(raw || '').trim();
            const targets = card.querySelectorAll('h2, .post-content, .author-name, .hint-tag');
            targets.forEach(node => {
                clearHighlight(node);
                if (!q || q.length < 2) return;
                highlightNode(node, q);
            });
        }

        function clearHighlight(node) {
            node.querySelectorAll('mark').forEach(m => {
                m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
            });
            if (node.parentNode) node.parentNode.normalize();
        }

        function highlightNode(node, q) {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
            const textNodes = [];
            let n;
            while ((n = walker.nextNode())) textNodes.push(n);
            const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            textNodes.forEach(tn => {
                const text = tn.nodeValue;
                if (!re.test(text)) return;
                re.lastIndex = 0;
                const frag = document.createDocumentFragment();
                let last = 0, m;
                while ((m = re.exec(text)) !== null) {
                    frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                    const mark = document.createElement('mark');
                    mark.className = 'search-hit';
                    mark.textContent = m[0];
                    frag.appendChild(mark);
                    last = m.index + m[0].length;
                }
                frag.appendChild(document.createTextNode(text.slice(last)));
                tn.parentNode.replaceChild(frag, tn);
            });
        }

        // Фильтр по тегу (клик по #тег)
        window.filterByTag = function(tag) {
            if (activeTag === tag) {
                activeTag = null;
                showToast('Фильтр по тегу снят');
            } else {
                activeTag = tag;
                showToast('Показаны истории с тегом #' + tag);
            }
            renderPosts();
        };

        // Облако всех тегов
        window.toggleAllTags = function() {
            const cloud = document.getElementById('allTagsCloud');
            const btn = document.getElementById('allTagsBtn');
            if (cloud.style.display === 'block') {
                cloud.style.display = 'none';
                btn.textContent = '🏷 Показать все теги';
                return;
            }
            const counts = {};
            posts.forEach(p => (p.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
            const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, 'ru'));
            if (!sorted.length) {
                cloud.innerHTML = '<span style="opacity:.7">Пока нет ни одного тега.</span>';
            } else {
                cloud.innerHTML = sorted.map(t =>
                    `<span class="hint-tag${activeTag === t ? ' active' : ''}" onclick="filterByTag('${escapeHTML(t)}')">#${escapeHTML(t)} <small>(${counts[t]})</small></span>`
                ).join('');
            }
            cloud.style.display = 'block';
            btn.textContent = '🏷 Скрыть теги';
        };

        // Экспорт своих историй
        window.exportMyPosts = function(format) {
            if (!userData.name || userData.isGuest) { showToast('Войди, чтобы экспортировать истории', true); return; }
            const mine = posts.filter(p => p.author === userData.name);
            if (!mine.length) { showToast('У тебя пока нет историй для экспорта', true); return; }

            let content, mime, ext;
            if (format === 'json') {
                content = JSON.stringify(mine.map(p => ({
                    id: p.id, title: p.title, text: p.text, date: p.date,
                    tags: p.tags || [], likes: p.likes,
                    comments: (p.comments || []).map(c => ({ author: c.author, text: c.text, date: c.date }))
                })), null, 2);
                mime = 'application/json;charset=utf-8';
                ext = 'json';
            } else {
                content = mine.map(p => {
                    const tags = (p.tags || []).length ? '\nТеги: ' + p.tags.map(t => '#' + t).join(' ') : '';
                    return `${p.title}\n${formatDate(p.date)}${tags}\n\n${p.text}\n\n${'—'.repeat(40)}\n`;
                }).join('\n');
                mime = 'text/plain;charset=utf-8';
                ext = 'txt';
            }

            const blob = new Blob([content], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const safeName = String(userData.name || 'author').replace(/[^\wа-яА-ЯёЁ-]+/g, '_');
            a.href = url;
            a.download = `skazki-${safeName}-${new Date().toISOString().slice(0, 10)}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showToast(`Экспортировано историй: ${mine.length}`);
        };

        // Только мои истории
        window.toggleMyOnly = function() {
            if (!userData.name || userData.isGuest) { showToast('Войди, чтобы отфильтровать свои истории', true); return; }
            myOnly = !myOnly;
            const btn = document.getElementById('myOnlyBtn');
            if (btn) {
                btn.textContent = myOnly ? '📖 Показать все истории' : '📖 Только мои истории';
                btn.style.borderColor = myOnly ? 'var(--gold-accent)' : 'var(--border-color)';
            }
            renderPosts();
        };

        // Время чтения (~180 слов в минуту)
        function readingTime(text) {
            const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
            const min = Math.max(1, Math.round(words / 180));
            return min + ' мин';
        }

        // Копировать ссылку на конкретный пост
        window.copyPostLink = function(id) {
            const url = location.origin + location.pathname + '#post-' + id;
            navigator.clipboard.writeText(url)
                .then(() => showToast('Ссылка на пост скопирована'))
                .catch(() => showToast('Не удалось скопировать', true));
        };

        // Сортировка: новые (по дате) или популярные (по лайкам)
        window.changeSort = function() {
            const mode = document.getElementById('sortSelect').value;
            const arr = [...posts];
            if (mode === 'popular') {
                arr.sort((a, b) => (b.likes || 0) - (a.likes || 0));
            } else {
                arr.sort((a, b) => new Date(b.date) - new Date(a.date));
            }
            posts = arr;
            visibleCount = postsPerPage;
            renderPosts();
        };

        window.sharePost = function(index) {
            const post = posts[index];
            if (!post) return;
            // Попытка нативного шеринга
            if (navigator.share) {
                navigator.share({ title: post.title, text: post.text.slice(0, 200) }).catch(() => {});
                return;
            }
            // Запасной вариант: копируем ссылку на карточку
            const url = location.origin + location.pathname + '#post-' + post.id;
            navigator.clipboard.writeText(url).then(() => showToast('Ссылка скопирована!')).catch(() => showToast('Не удалось скопировать', true));
        };

        // Модерация: пожаловаться
        window.reportPost = async function(id) {
            const post = posts.find(p => p.id === id);
            if (!post) return;
            const answer = await uiPrompt('Жалоба на историю', {
                text: 'Расскажи, что не так — модератор посмотрит.',
                inputLabel: 'Причина (необязательно):',
                placeholder: 'Например: оскорбления',
                multiline: true,
                okText: 'Отправить'
            });
            if (answer === null) return;
            const reason = answer.trim();
            try {
                await api('/api/report', { method: 'POST', body: JSON.stringify({ type: 'post', target_id: String(id), target_author: post.author, reporter: userData.name, reason }) });
                showToast('Жалоба отправлена. Спасибо!');
            } catch (e) { showToast(e.message, true); }
        };

        window.reportComment = async function(commentId, author) {
            const answer = await uiPrompt('Жалоба на комментарий', {
                text: 'Расскажи, что не так — модератор посмотрит.',
                inputLabel: 'Причина (необязательно):',
                placeholder: 'Например: спам',
                multiline: true,
                okText: 'Отправить'
            });
            if (answer === null) return;
            const reason = answer.trim();
            try {
                await api('/api/report', { method: 'POST', body: JSON.stringify({ type: 'comment', target_id: String(commentId), target_author: author, reporter: userData.name, reason }) });
                showToast('Жалоба отправлена. Спасибо!');
            } catch (e) { showToast(e.message, true); }
        };

        // Уведомления: показываем счётчик новых комментариев к моим постам (после последнего клика)
        const NOTIF_KEY = 'shersh_notif_seen';
        function updateBell() {
            const bellBtn = document.getElementById('bellBtn');
            const bellBadge = document.getElementById('bellBadge');
            if (!bellBtn || !userData.name || userData.isGuest) return;
            // суммарное число комментариев к постам автора
            const myPosts = posts.filter(p => p.author === userData.name);
            let totalComments = myPosts.reduce((s, p) => s + (p.comments ? p.comments.length : 0), 0);
            const seen = parseInt(localStorage.getItem(NOTIF_KEY) || '0', 10);
            const count = totalComments - seen;
            if (count > 0) {
                bellBadge.textContent = count > 99 ? '99+' : count;
                bellBadge.style.display = 'flex';
            } else {
                bellBadge.style.display = 'none';
            }
        }

        document.getElementById('bellBtn').addEventListener('click', () => {
            const bellBadge = document.getElementById('bellBadge');
            bellBadge.style.display = 'none';
            const myPosts = posts.filter(p => p.author === userData.name);
            const totalComments = myPosts.reduce((s, p) => s + (p.comments ? p.comments.length : 0), 0);
            localStorage.setItem(NOTIF_KEY, String(totalComments));
            showToast('Вы просмотрели свои уведомления');
        });

        window.toggleLike = async function(index) {
            const post = posts[index];
            if (!userData.name || userData.isGuest) { showToast('Гости не могут ставить лайки!', true); return; }
            try {
                const data = await api('/api/posts/' + post.id + '/like', { method: 'POST', body: JSON.stringify({ user: userData.name }) });
                post.isLiked = (data.status === 'liked');
                post.likes = data.likes;
                if (post.isLiked) likedSet.add(post.id); else likedSet.delete(post.id);
                localStorage.setItem(POSTS_CACHE_KEY, JSON.stringify(posts));
                renderPosts();
            } catch (e) { showToast(e.message, true); }
        };

        window.editPost = function(id) {
            const post = posts.find(p => p.id === id);
            if (!post) return;
            
            editingPostId = id;
            document.getElementById('postModalTitle').textContent = 'Редактировать историю';
            document.getElementById('postTitle').value = post.title;
            document.getElementById('postText').value = post.text;
            document.getElementById('submitPostBtn').textContent = 'Сохранить';
            currentPostImageBase64 = post.image || null;
            document.getElementById('postImageInput').value = ''; 
            updateWordCount(); postModal.style.display = 'flex';
        };

        window.deletePost = async function(id) {
            try {
                await api('/api/posts/' + id, { method: 'DELETE', body: JSON.stringify({ user: userData.name }) });
                posts = posts.filter(p => p.id !== id);
                localStorage.setItem(POSTS_CACHE_KEY, JSON.stringify(posts));
                renderPosts();
                showToast('История удалена');
            } catch (e) { showToast(e.message, true); }
        };

        document.getElementById('postImageInput').addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                const vErr = validateImageFile(file);
                if (vErr) { showToast(vErr, true); e.target.value = ''; currentPostImageBase64 = null; return; }
                compressImage(file)
                    .then(b64 => uploadImage(b64))
                    .then(url => { currentPostImageBase64 = url; showToast('Картинка загружена!'); })
                    .catch(err => showToast(err.message, true));
            } else { currentPostImageBase64 = null; }
        });

        document.getElementById('addPostBtn').addEventListener('click', () => {
            if(!userData.name || userData.isGuest) { showToast('Гости не могут писать истории!', true); return; }
            editingPostId = null; currentPostImageBase64 = null;
            document.getElementById('postModalTitle').textContent = 'Новая история';
            document.getElementById('postTitle').value = ''; document.getElementById('postText').value = '';
            document.getElementById('postImageInput').value = '';
            document.getElementById('submitPostBtn').textContent = 'Опубликовать!';
            // восстановить черновик, если есть
            const draft = localStorage.getItem('shersh_post_draft');
            if (draft) {
                try {
                    const d = JSON.parse(draft);
                    if (d.title || d.text) {
                        document.getElementById('postTitle').value = d.title || '';
                        document.getElementById('postText').value = d.text || '';
                        showToast('Черновик восстановлен');
                    }
                } catch(e) {}
            }
            updateWordCount(); postModal.style.display = 'flex';
            document.getElementById('postTitle').focus();
        });

        // Автосохранение черновика при вводе
        ['postTitle', 'postText'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => {
                if (editingPostId) return; // не перетираем при редактировании существующего
                localStorage.setItem('shersh_post_draft', JSON.stringify({
                    title: document.getElementById('postTitle').value,
                    text: document.getElementById('postText').value
                }));
            });
        });

        document.getElementById('cancelBtn').addEventListener('click', () => { postModal.style.display = 'none'; });

        document.getElementById('submitPostBtn').addEventListener('click', async () => {
            const title = document.getElementById('postTitle').value.trim();
            const text = document.getElementById('postText').value.trim();
            if (!title || !text) { showToast('Заполни заголовок и текст!', true); return; }

            const btn = document.getElementById('submitPostBtn');
            try {
                await withLoading(btn, async () => {
                    if (editingPostId) {
                        await api('/api/posts/' + editingPostId, { method: 'PATCH', body: JSON.stringify({ title, text, image: currentPostImageBase64 }) });
                        showToast('История обновлена!');
                    } else {
                        await api('/api/posts', { method: 'POST', body: JSON.stringify({ title, text, author: userData.name, image: currentPostImageBase64 }) });
                        showToast('История опубликована!');
                    }
                });
                postModal.style.display = 'none';
                if (!editingPostId) localStorage.removeItem('shersh_post_draft');
                await loadPosts();
            } catch (e) { showToast(e.message, true); }
        });

        // --- КОММЕНТАРИИ ---
        const commentsModal = document.getElementById('commentsModal');
        const commentsList = document.getElementById('commentsList');
        const commentInput = document.getElementById('commentInput');
        const commentImagePreview = document.getElementById('commentImagePreview');
        let currentPostIndexForComments = null;
        let replyTo = null; // { id, author } — на какой комментарий отвечаем

        window.setReply = function(commentId, author) {
            if (!userData.name || userData.isGuest) { showToast('Гости не могут отвечать на комментарии', true); return; }
            replyTo = { id: commentId, author: author };
            const ind = document.getElementById('replyIndicator');
            const txt = document.getElementById('replyIndicatorText');
            if (ind && txt) {
                txt.textContent = 'Ответ для ' + author;
                ind.style.display = 'flex';
            }
            const inp = document.getElementById('commentInput');
            if (inp) { inp.focus(); inp.placeholder = 'Ответ для ' + author + '...'; }
        };

        window.cancelReply = function() {
            replyTo = null;
            const ind = document.getElementById('replyIndicator');
            if (ind) ind.style.display = 'none';
            const inp = document.getElementById('commentInput');
            if (inp) inp.placeholder = 'Написать комментарий...';
        };

        // «Читайте также»: похожие истории по общим тегам
        function renderRelated(currentIndex) {
            const block = document.getElementById('relatedBlock');
            const list = document.getElementById('relatedList');
            if (!block || !list) return;

            const current = posts[currentIndex];
            const currentTags = (current && current.tags) || [];
            if (!currentTags.length) { block.style.display = 'none'; list.innerHTML = ''; return; }

            const scored = posts
                .map((post, index) => {
                    if (index === currentIndex) return null;
                    const shared = ((post.tags || []).filter(t => currentTags.includes(t)));
                    if (!shared.length) return null;
                    return { post, index, shared };
                })
                .filter(Boolean)
                .sort((a, b) => b.shared.length - a.shared.length)
                .slice(0, 3);

            if (!scored.length) { block.style.display = 'none'; list.innerHTML = ''; return; }

            list.innerHTML = scored.map(({ post, index, shared }) => `
                <button type="button" class="related-item" onclick="openRelatedPost(${index}, ${post.id})">
                    <b>${escapeHTML(post.title)}</b>
                    <span>${escapeHTML(post.author)} · общие теги: ${shared.map(t => '#' + escapeHTML(t)).join(' ')}</span>
                </button>
            `).join('');
            block.style.display = 'block';
        }

        window.openRelatedPost = function(index, id) {
            commentsModal.style.display = 'none';
            showPage('feed');
            const post = posts[index];
            if (post) {
                currentPostIndexForComments = index;
                renderComments();
            }
            scrollToPost(id);
        };

        window.openComments = function(index) {
            currentPostIndexForComments = index;
            cancelReply();
            renderComments();
            renderRelated(index);
            const post = posts[index];
            if (post) markCommentsSeen(post.id, (post.comments || []).length);
            commentsModal.style.display = 'flex';
        };

        document.getElementById('commentImageInput').addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                const vErr = validateImageFile(file);
                if (vErr) { showToast(vErr, true); e.target.value = ''; currentCommentImageBase64 = null; commentImagePreview.style.display = 'none'; return; }
                compressImage(file)
                    .then(b64 => uploadImage(b64))
                    .then(url => {
                        currentCommentImageBase64 = url;
                        commentImagePreview.src = url;
                        commentImagePreview.style.display = 'inline-block';
                    })
                    .catch(err => showToast(err.message, true));
            } else {
                currentCommentImageBase64 = null;
                commentImagePreview.style.display = 'none';
            }
        });

        function renderComments() {
            commentsList.innerHTML = '';
            const post = posts[currentPostIndexForComments];
            if (!post) {
                commentsList.innerHTML = `
                    <div class="skeleton-card" style="padding:12px;">
                        <div class="skeleton-line" style="width:35%"></div>
                        <div class="skeleton-line"></div>
                        <div class="skeleton-line short"></div>
                    </div>`;
                return;
            }
            const comments = post.comments || [];
            if (comments.length === 0) {
                commentsList.innerHTML = '<p style="color: #888; text-align: center;">Пока нет комментариев. Будь первым!</p>';
            } else {
                // группируем: корни + ответы (вложенность 1 уровень)
                const roots = comments.filter(c => !c.parent_id);
                const repliesByParent = {};
                comments.filter(c => c.parent_id).forEach(c => {
                    const key = String(c.parent_id);
                    (repliesByParent[key] = repliesByParent[key] || []).push(c);
                });
                // если корень не найден (удалён), показываем ответ как корень
                const orphanReplies = Object.keys(repliesByParent)
                    .filter(k => !roots.some(r => String(r.id) === k))
                    .flatMap(k => repliesByParent[k]);

                roots.forEach(c => {
                    commentsList.appendChild(buildCommentNode(c, false));
                    (repliesByParent[String(c.id)] || []).forEach(r => {
                        commentsList.appendChild(buildCommentNode(r, true));
                    });
                });
                orphanReplies.forEach(c => commentsList.appendChild(buildCommentNode(c, false)));
            }
            commentInput.value = '';
            currentCommentImageBase64 = null;
            commentImagePreview.style.display = 'none';
            commentImagePreview.src = '';
        }

        function buildCommentNode(c, isReply) {
            const div = document.createElement('div');
            div.className = 'comment-item' + (isReply ? ' comment-reply' : '');

            const imageHTML = c.image ? `<img src="${c.image}" class="comment-image" alt="Фото в комментарии" loading="lazy" onclick="openImageModal('${c.image}')">` : '';
            const own = userData.name && c.author === userData.name && !userData.isGuest;
            const editBtn = own
                ? `<button class="delete-comment-btn" onclick="editComment(${c.id})" title="Редактировать комментарий" aria-label="Редактировать комментарий">✏️</button>`
                : '';
            const deleteBtn = own
                ? `<button class="delete-comment-btn" onclick="deleteComment(${c.id})" title="Удалить комментарий" aria-label="Удалить комментарий">🗑️</button>`
                : '';
            const reportBtn = !userData.isGuest && userData.name
                ? `<button class="delete-comment-btn" onclick="reportComment(${c.id}, '${escapeHTML(c.author)}')" title="Пожаловаться" aria-label="Пожаловаться на комментарий">🚩</button>`
                : '';
            const replyBtn = !isReply && !userData.isGuest && userData.name
                ? `<button class="delete-comment-btn reply-btn" onclick="setReply(${c.id}, '${escapeHTML(c.author).replace(/'/g, "\\'")}')" title="Ответить" aria-label="Ответить на комментарий">↩️</button>`
                : '';

            div.innerHTML = `
                <div class="comment-header">
                    <span class="comment-author">${escapeHTML(c.author)}</span>
                    <span>${formatDate(c.date)}</span>
                    ${replyBtn}
                    ${editBtn}
                    ${reportBtn}
                    ${deleteBtn}
                </div>
                <div class="comment-text" data-cid="${c.id}">${escapeHTML(c.text)}</div>
                ${imageHTML}
            `;
            return div;
        }

        document.getElementById('closeCommentsBtn').addEventListener('click', () => { commentsModal.style.display = 'none'; });

        document.getElementById('submitCommentBtn').addEventListener('click', async () => {
            if(!userData.name || userData.isGuest) { showToast('Гости не могут писать комментарии!', true); return; }
            const text = commentInput.value.trim();
            if (!text && !currentCommentImageBase64) return; 

            const post = posts[currentPostIndexForComments];
            const btn = document.getElementById('submitCommentBtn');
            const wasReply = !!replyTo;
            try {
                await withLoading(btn, async () => {
                    const payload = {
                        author: userData.name, text: text || '📷 Фото', image: currentCommentImageBase64
                    };
                    if (replyTo) payload.parent_id = replyTo.id;
                    await api('/api/posts/' + post.id + '/comments', { method: 'POST', body: JSON.stringify(payload) });
                });
                await loadPosts();
                if (posts[currentPostIndexForComments]) renderComments();
                commentInput.value = ''; currentCommentImageBase64 = null;
                commentImagePreview.style.display = 'none';
                cancelReply();
                showToast(wasReply ? 'Ответ отправлен!' : 'Комментарий добавлен!');
            } catch (e) { showToast(e.message, true); }
        });

        window.editComment = async function(commentId) {
            const current = document.querySelector('.comment-text[data-cid="' + commentId + '"]');
            const newText = await uiPrompt('Изменить комментарий', {
                text: 'Правки сразу увидишь в обсуждении.',
                value: current ? current.textContent.trim() : '',
                placeholder: 'Текст комментария',
                multiline: true,
                okText: 'Сохранить'
            });
            if (newText === null) return;
            const text = newText.trim();
            if (!text) { showToast('Пустой комментарий', true); return; }
            try {
                await api('/api/comments/' + commentId, { method: 'PATCH', body: JSON.stringify({ user: userData.name, text }) });
                await loadPosts();
                if (posts[currentPostIndexForComments]) renderComments();
                showToast('Комментарий обновлён');
            } catch (e) { showToast(e.message, true); }
        };

        window.deleteComment = async function(commentId) {
            const ok = await uiConfirm('Удалить комментарий?', 'Вернуть его потом не получится.', { okText: 'Удалить', danger: true });
            if (!ok) return;
            try {
                await api('/api/comments/' + commentId, { method: 'DELETE', body: JSON.stringify({ user: userData.name }) });
                await loadPosts();
                if (posts[currentPostIndexForComments]) renderComments();
                showToast('Комментарий удалён');
            } catch (e) { showToast(e.message, true); }
        };

        async function updateLikedSet() {
            if (!userData.name || userData.isGuest) return;
            try {
                const ids = await api('/api/liked?user=' + encodeURIComponent(userData.name));
                likedSet = new Set(ids);
                posts.forEach(p => p.isLiked = likedSet.has(p.id));
                renderPosts();
            } catch (e) {}
        }

        // --- ИНИЦИАЛИЗАЦИЯ ---
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js').catch(() => {});
        }

        async function init() {
            await loadProfiles();
            validateStoredSession();
            await loadPosts();
            checkAuth();
            if (userData.name && !userData.isGuest) updateLikedSet();
        }
        init();

        // Если в браузере осталась сессия удалённого профиля — не даём пользователю
        // получать загадочное «Пользователь не найден» при смене пароля.
        function validateStoredSession() {
            if (!userData.name || userData.isGuest) return false;
            const known = Object.keys(usersMap || {});
            if (!known.length) return false;
            if (usersMap[userData.name]) return false;

            const stale = userData.name;
            clearSession();
            localStorage.removeItem('shersh_seen_comments');
            userData = { name: '', nickname: '', bio: '', avatar: '', isGuest: true };
            showToast('Профиль «' + stale + '» больше не существует — войдите заново', true);
            return true;
        }

        // Открытие модалок "О проекте" и "Правила"
        window.showAbout = function() { document.getElementById('aboutModal').style.display = 'flex'; };
        window.showRules = function() { document.getElementById('rulesModal').style.display = 'flex'; };

        // «Сказка на ночь»: сборка новой сказки прямо в браузере
        const taleModal = document.getElementById('taleModal');
        const LAST_TALE_KEY = 'shersh_last_tale';
        let currentTale = null;

        function saveTale(tale) {
            try { localStorage.setItem(LAST_TALE_KEY, JSON.stringify(tale)); } catch (e) { /* приватный режим */ }
        }

        function loadTale() {
            try {
                const raw = localStorage.getItem(LAST_TALE_KEY);
                if (!raw) return null;
                const tale = JSON.parse(raw);
                return (tale && tale.text && tale.title) ? tale : null;
            } catch (e) { return null; }
        }

        function showTale(tale) {
            if (!tale) return;
            currentTale = tale;
            document.getElementById('taleTitle').textContent = tale.title;
            document.getElementById('taleText').textContent = tale.text;
            document.getElementById('taleText').scrollTop = 0;
            saveTale(tale);
        }

        function renderTale() {
            if (typeof window.makeTale !== 'function') {
                showToast('Генератор сказок не загрузился — обнови страницу', true);
                return;
            }
            showTale(window.makeTale());
        }

        window.randomTale = function() {
            const saved = loadTale();
            if (saved) showTale(saved);
            else renderTale();
            taleModal.style.display = 'flex';
        };

        document.getElementById('taleAgainBtn').addEventListener('click', renderTale);

        document.getElementById('taleContinueBtn').addEventListener('click', () => {
            if (typeof window.makeContinuation !== 'function') {
                showToast('Генератор сказок не загрузился — обнови страницу', true);
                return;
            }
            if (!currentTale) { renderTale(); return; }
            showTale(window.makeContinuation(currentTale));
        });

        document.getElementById('taleCloseBtn').addEventListener('click', () => { taleModal.style.display = 'none'; });

        document.getElementById('taleCopyBtn').addEventListener('click', async () => {
            if (!currentTale) return;
            try {
                await navigator.clipboard.writeText(currentTale.title + '\n\n' + currentTale.text);
                showToast('Сказка скопирована');
            } catch (e) {
                showToast('Не удалось скопировать', true);
            }
        });

        document.getElementById('taleFromSiteBtn').addEventListener('click', () => {
            taleModal.style.display = 'none';
            if (!posts.length) { showToast('Пока нет историй — стань первым!', true); return; }
            window.openComments(Math.floor(Math.random() * posts.length));
        });

        document.getElementById('talePublishBtn').addEventListener('click', () => {
            if (!currentTale) return;
            if (!userData.name || userData.isGuest) { showToast('Войди в аккаунт, чтобы опубликовать', true); return; }
            taleModal.style.display = 'none';
            editingPostId = null;
            currentPostImageBase64 = null;
            document.getElementById('postModalTitle').textContent = 'Новая история';
            document.getElementById('postTitle').value = currentTale.title;
            document.getElementById('postText').value = currentTale.text;
            document.getElementById('postImageInput').value = '';
            document.getElementById('submitPostBtn').textContent = 'Опубликовать!';
            updateWordCount();
            postModal.style.display = 'flex';
            document.getElementById('postTitle').focus();
        });

        // Поддержка проекта (без платежей — контакт создателя / копия ссылки на репозиторий)
        window.supportProject = function() {
            if (navigator.share) {
                navigator.share({ title: 'Сказки Шерша', text: 'Поддержите уютное сообщество сказок!', url: location.href }).catch(() => {});
                return;
            }
            navigator.clipboard.writeText(location.href)
                .then(() => showToast('Ссылка на проект скопирована. Спасибо за поддержку!'))
                .catch(() => showToast('Не удалось скопировать', true));
        };

        // Динамический Open Graph: если открыт пост по #post-<id>, обновляем OG-теги для карточки при шеринге
        function updateOGForCurrentPost() {
            const m = location.hash.match(/^#post-(\d+)/);
            if (!m) {
                document.title = 'Сказки Шерша';
                return;
            }
            const post = posts.find(p => p.id === Number(m[1]));
            if (!post) return;
            const setMeta = (sel, val) => { const el = document.querySelector(sel); if (el) el.setAttribute('content', val); };
            setMeta('meta[property="og:title"]', post.title);
            setMeta('meta[property="og:description"]', (post.text || '').slice(0, 200));
            if (post.image) setMeta('meta[property="og:image"]', post.image);
            setMeta('meta[property="og:url"]', location.href.split('#')[0] + '#post-' + post.id);

            document.title = post.title + ' — Сказки Шерша';

            // JSON-LD Article
            setJsonLd('ld-article', {
                '@context': 'https://schema.org',
                '@type': 'Article',
                headline: post.title,
                articleBody: (post.text || '').slice(0, 3000),
                datePublished: post.date,
                author: { '@type': 'Person', name: post.author },
                image: post.image ? [post.image] : undefined,
                mainEntityOfPage: location.href.split('#')[0] + '#post-' + post.id
            });

            // Хлебные крошки
            setJsonLd('ld-breadcrumbs', {
                '@context': 'https://schema.org',
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Истории', item: location.origin + location.pathname },
                    { '@type': 'ListItem', position: 2, name: post.title, item: location.href.split('#')[0] + '#post-' + post.id }
                ]
            });
        }

        function setJsonLd(id, obj) {
            let el = document.getElementById(id);
            if (!el) {
                el = document.createElement('script');
                el.type = 'application/ld+json';
                el.id = id;
                document.head.appendChild(el);
            }
            el.textContent = JSON.stringify(obj);
        }
        window.addEventListener('hashchange', updateOGForCurrentPost);
        setTimeout(updateOGForCurrentPost, 1500);

        // --- Модалки: закрытие по Esc и клику по фону + блокировка прокрутки ---
        function syncBodyScrollLock() {
            const anyOpen = Array.from(document.querySelectorAll('.modal-overlay'))
                .some(m => getComputedStyle(m).display === 'flex');
            document.body.style.overflow = anyOpen ? 'hidden' : '';
        }
        const _origShowToastNone = null;
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay').forEach(m => {
                    if (getComputedStyle(m).display === 'flex') m.style.display = 'none';
                });
                syncBodyScrollLock();
            }
        });
        // Клик по тёмному фону (не по содержимому) закрывает модалку
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('mousedown', (e) => {
                if (e.target === overlay) { overlay.style.display = 'none'; syncBodyScrollLock(); }
            });
        });
        // Следим за открытием/закрытием модалок для блокировки прокрутки
        const overlayObserver = new MutationObserver(syncBodyScrollLock);
        document.querySelectorAll('.modal-overlay').forEach(m =>
            overlayObserver.observe(m, { attributes: true, attributeFilter: ['style'] })
        );

        // --- Кнопка «Наверх» ---
        // Кнопка «Наверх» лежит ниже скрипта — ищем её лениво, чтобы не падать на null
        window.addEventListener('scroll', () => {
            const b = document.getElementById('backToTop');
            if (b) b.style.display = window.scrollY > 400 ? 'block' : 'none';
        });
        document.addEventListener('DOMContentLoaded', () => {
            const b = document.getElementById('backToTop');
            if (b) b.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
        });

        // --- Фокус-ловушка: Tab не уходит из открытой модалки ---
        function topVisibleModal() {
            const modals = Array.from(document.querySelectorAll('.modal-overlay'))
                .filter(m => getComputedStyle(m).display !== 'none');
            return modals.length ? modals[modals.length - 1] : null;
        }

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            const modal = topVisibleModal();
            if (!modal) return;
            const focusable = Array.from(modal.querySelectorAll(
                'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )).filter(el => el.offsetParent !== null);
            if (!focusable.length) return;

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;

            if (!modal.contains(active)) {
                e.preventDefault();
                first.focus();
            } else if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        });
