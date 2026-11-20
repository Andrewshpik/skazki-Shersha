// Точка входа приложения. Общие утилиты и клиент API живут в shared.
import { API_BASE, TOKEN_KEY, POSTS_CACHE_KEY, MAX_UPLOAD_BYTES } from '../shared/config.js';
import { api, getToken, setToken, clearToken, clearSession, setRetryHandler } from '../shared/lib/api.js';
import { escapeHTML, formatDate, readingTime, normalizeForSearch } from '../shared/lib/format.js';
import { validateImageFile, compressImage, uploadImage } from '../shared/lib/images.js';
import { extractTags } from '../entities/post/model.js';
import { setToastHandler, refreshOfflineButtons } from '../features/offline-save/index.js';
import { renderTaleOfDay } from '../widgets/tale-of-day/index.js';
import { renderFeed } from '../widgets/feed/index.js';
import { trackView } from '../features/page-view/index.js';
import { updateBell, initNotifications } from '../widgets/notifications/index.js';
import { filterPosts } from '../features/search/index.js';
import { getActiveTag, initTagFilter, syncTagFromHash } from '../features/tag-filter/index.js';
import { initLikes } from '../features/like/index.js';
import { setToastHandler as setShareToast } from '../features/share/index.js';
import { initReports } from '../features/report/index.js';
import { renderCommentsInto } from '../features/comments/index.js';
import { updateHeaderUI as updateHeaderView, showPage as showPageView } from '../widgets/header/index.js';
import { openUiDialog, uiConfirm, uiPrompt, openImageModal, closeImageModal, syncBodyScrollLock, topVisibleModal } from '../widgets/modals/index.js';

        // Сжатие изображения на клиенте (уменьшает вес до ~1280px по ширине)

        // Загрузка base64-изображения на сервер, возвращает URL в Storage
        let posts = [];
        let usersMap = {}; // name -> profile (для аватаров/ников)

        // Аксессоры состояния для модулей (их читает src/shared/state.js)
        window.__getPosts = () => posts;
        window.__getCurrentPostIndex = () => currentPostIndexForComments;
        window.__getUser = () => userData;

        // Извлечение тегов вида #тег из текста

        async function loadPosts() {
            // Показываем скелетон только если нет кеша (первый заход)
            if (!localStorage.getItem(POSTS_CACHE_KEY)) showFeedSkeleton();
            // Сначала показываем кешированную ленту, если есть (работает даже когда сервер Netrun спит)
            const cached = localStorage.getItem(POSTS_CACHE_KEY);
            if (cached) {
                try {
                    posts = JSON.parse(cached);
                    renderPosts();
                    syncTagFromHash();
                } catch (e) {}
            }
            try {
                const rows = await api('/api/posts');
                posts = rows.map(r => ({
                    id: r.id, title: r.title, text: r.text, author: r.author,
                    date: r.date, image: r.image, likes: r.likes || 0,
                    views: (r.views === undefined ? null : r.views),
                    audio: r.audio || null,
                    comments: r.comments || [], isLiked: likedSet.has(r.id),
                    tags: extractTags(r.title + ' ' + r.text)
                }));
                localStorage.setItem(POSTS_CACHE_KEY, JSON.stringify(posts));
                renderPosts();
                syncTagFromHash();
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
            if (userData.name && !userData.isGuest) { updateLikedSet(); loadSubscriptions(); }
        }

        const loginModal = document.getElementById('loginModal');
        const editProfileModal = document.getElementById('editProfileModal');
        const postModal = document.getElementById('postModal');
        const deleteAccountModal = document.getElementById('deleteAccountModal');
        let editingPostId = null;
        let currentPostImageBase64 = null;
        let currentPostAudio = null;
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

            const consent = document.getElementById('regConsent');
            if (consent && !consent.checked) {
                showToast('Отметь согласие на обработку персональных данных', true);
                return;
            }

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
            updateHeaderView(userData);
        }

        function showPage(page) {
            showPageView(page, userData, updateProfileUI);
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
            updateSubscribeUI();
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
        let myAuthorsOnly = false; // фильтр «только мои авторы»
        let myAuthors = new Set(); // на кого подписан пользователь

        function showMorePosts() {
            visibleCount += postsPerPage;
            renderPosts();
        }

        // Просмотры: один запрос на историю за сессию, и только если колонка уже есть
function renderPosts() {
    renderFeed(postsContainer, posts, {
        userData,
        usersMap,
        activeTag: getActiveTag(),
        myOnly,
        myAuthors: myAuthorsOnly ? myAuthors : null,
        visibleCount,
        newCommentsBadge,
        trackView,
        onMore: showMorePosts,
        afterRender: () => {
            // после перерисовки ленты сохраняем активный поиск
            const searchEl = document.getElementById('searchInput');
            if (searchEl && searchEl.value.trim()) filterPosts(true);
            refreshOfflineButtons();
            renderTaleOfDay();
        }
    });
}

// Подсветка совпадений в заголовке, тексте, авторе и тегах
// Фильтр по тегу (клик по #тег)
        // Тег как адрес: #tag/зима — ссылку можно отправить или добавить в закладки

        function collapseTagsCloud() {
            const cloud = document.getElementById('allTagsCloud');
            const btn = document.getElementById('allTagsBtn');
            if (cloud && cloud.style.display === 'block') {
                cloud.style.display = 'none';
                if (btn) btn.textContent = '🏷 Показать все теги';
            }
        }

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
                    `<span class="hint-tag${getActiveTag() === t ? ' active' : ''}" onclick="filterByTag('${escapeHTML(t)}')">#${escapeHTML(t)} <small>(${counts[t]})</small></span>`
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
        window.toggleMyOnly = function() {            if (!userData.name || userData.isGuest) { showToast('Войди, чтобы отфильтровать свои истории', true); return; }
            myOnly = !myOnly;
            const btn = document.getElementById('myOnlyBtn');
            if (btn) {
                btn.textContent = myOnly ? '📖 Показать все истории' : '📖 Только мои истории';
                btn.style.borderColor = myOnly ? 'var(--gold-accent)' : 'var(--border-color)';
            }
            renderPosts();
        };

        // Подписки на авторов
        async function loadSubscriptions() {
            if (!userData.name || userData.isGuest) { myAuthors = new Set(); return; }
            try {
                const data = await api('/api/subscriptions');
                myAuthors = new Set((data && data.authors) || []);
            } catch (e) { myAuthors = new Set(); }
            updateSubscribeUI();
        }

        function updateSubscribeUI() {
            const btn = document.getElementById('subscribeBtn');
            if (btn) {
                const name = window.__currentProfileName;
                const visible = !!name && name !== userData.name && !!userData.name && !userData.isGuest;
                btn.style.display = visible ? 'inline-block' : 'none';
                if (visible) {
                    const subscribed = myAuthors.has(name);
                    btn.textContent = subscribed ? '✅ Вы подписаны' : '➕ Подписаться';
                    btn.classList.toggle('is-subscribed', subscribed);
                }
            }
            const feedBtn = document.getElementById('myAuthorsBtn');
            if (feedBtn) {
                const count = myAuthors.size;
                feedBtn.textContent = myAuthorsOnly
                    ? '❤️ Показать все истории'
                    : '❤️ Мои авторы' + (count ? ' (' + count + ')' : '');
                feedBtn.style.borderColor = myAuthorsOnly ? 'var(--gold-accent)' : 'var(--border-color)';
            }
        }

        window.toggleMyAuthors = async function() {
            if (!userData.name || userData.isGuest) { showToast('Войди, чтобы видеть своих авторов', true); return; }
            if (!myAuthors.size) {
                showToast('Вы пока ни на кого не подписаны — откройте профиль автора и нажмите «Подписаться»');
                return;
            }
            myAuthorsOnly = !myAuthorsOnly;
            updateSubscribeUI();
            renderPosts();
        };

        window.toggleSubscribe = async function(name) {
            if (!userData.name || userData.isGuest) { showToast('Войди, чтобы подписаться', true); return; }
            if (!name) return;
            try {
                const data = await api('/api/subscribe', { method: 'POST', body: JSON.stringify({ author: name }) });
                if (data && data.subscribed) {
                    myAuthors.add(name);
                    showToast('Вы подписаны на ' + name);
                } else {
                    myAuthors.delete(name);
                    showToast('Вы отписались от ' + name);
                }
                updateSubscribeUI();
            } catch (e) { showToast(e.message, true); }
        };

        window.toggleSubscribeCurrent = function() {
            window.toggleSubscribe(window.__currentProfileName);
        };

        // Время чтения (~180 слов в минуту)
        // Копировать ссылку на конкретный пост
        // Офлайн-чтение: сохраняем страницу истории в отдельный кеш браузера

// Сказка дня: одна история на сутки, выбор детерминированный по дате
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

// Модерация: пожаловаться
// Уведомления: показываем счётчик новых комментариев к моим постам (после последнего клика)

// Уведомления собираются из уже загруженной ленты: отдельной таблицы не нужно
window.editPost = function(id) {
            const post = posts.find(p => p.id === id);
            if (!post) return;
            
            editingPostId = id;
            document.getElementById('postModalTitle').textContent = 'Редактировать историю';
            document.getElementById('postTitle').value = post.title;
            document.getElementById('postText').value = post.text;
            document.getElementById('submitPostBtn').textContent = 'Сохранить';
            currentPostImageBase64 = post.image || null;
            setAudioStatus(post.audio || null);
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

        function setAudioStatus(url) {
            currentPostAudio = url || null;
            const status = document.getElementById('postAudioStatus');
            if (!status) return;
            if (currentPostAudio) {
                status.style.display = 'block';
                status.textContent = '🎧 Озвучка прикреплена — её услышат вместо синтеза';
            } else {
                status.style.display = 'none';
                status.textContent = '';
            }
        }

        const postAudioInput = document.getElementById('postAudioInput');
        if (postAudioInput) postAudioInput.addEventListener('change', function (e) {
            const file = e.target.files[0];
            if (!file) { setAudioStatus(null); return; }
            if (!/^audio\//i.test(file.type)) {
                showToast('Нужен аудиофайл: mp3, m4a, ogg или wav', true);
                e.target.value = '';
                return;
            }
            if (file.size > 15 * 1024 * 1024) {
                showToast('Файл больше 15 МБ — сожмите озвучку', true);
                e.target.value = '';
                return;
            }
            const status = document.getElementById('postAudioStatus');
            if (status) { status.style.display = 'block'; status.textContent = '⏳ Загружаю озвучку...'; }
            const reader = new FileReader();
            reader.onload = () => {
                api('/api/audio', { method: 'POST', body: JSON.stringify({ audio: reader.result }) })
                    .then(data => {
                        if (!data || !data.url) throw new Error('Сервер не вернул ссылку на файл');
                        setAudioStatus(data.url);
                        showToast('Озвучка загружена');
                    })
                    .catch(err => {
                        setAudioStatus(null);
                        e.target.value = '';
                        showToast(err.message, true);
                    });
            };
            reader.onerror = () => { setAudioStatus(null); showToast('Не удалось прочитать файл', true); };
            reader.readAsDataURL(file);
        });

        document.getElementById('addPostBtn').addEventListener('click', () => {
            if(!userData.name || userData.isGuest) { showToast('Гости не могут писать истории!', true); return; }
            editingPostId = null; currentPostImageBase64 = null;
            setAudioStatus(null);
            document.getElementById('postAudioInput').value = '';
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
                        await api('/api/posts/' + editingPostId, { method: 'PATCH', body: JSON.stringify({ title, text, image: currentPostImageBase64, audio: currentPostAudio }) });
                        showToast('История обновлена!');
                    } else {
                        await api('/api/posts', { method: 'POST', body: JSON.stringify({ title, text, author: userData.name, image: currentPostImageBase64, audio: currentPostAudio }) });
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
    renderCommentsInto(commentsList, post.comments || [], userData);
    commentInput.value = '';
    currentCommentImageBase64 = null;
    commentImagePreview.style.display = 'none';
    commentImagePreview.src = '';
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
                if (!/^#tag\//.test(location.hash || '')) document.title = 'Сказки Шерша';
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
            if (userData.name && !userData.isGuest) loadSubscriptions();
        });

        // --- Фокус-ловушка: Tab не уходит из открытой модалки ---

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

        // Слой совместимости: разметка зовёт функции через inline-обработчики,
        // а внутри ES-модуля они не попадают в глобальную область сами по себе.
        setToastHandler(showToast);
        initNotifications();
        initTagFilter({ render: renderPosts, toast: showToast, collapseCloud: collapseTagsCloud });
        initLikes({ toast: showToast, render: renderPosts, getLikedSet: () => likedSet });
        setShareToast(showToast);
        setRetryHandler((attempt, total) => showToast(`Сервер просыпается, ещё попытка (${attempt} из ${total})…`));
        initReports({ prompt: uiPrompt, toast: showToast });
        Object.assign(window, {
            openImageModal,
            closeImageModal,
            insertHint,
            showPage,
            switchAuthTab,
            togglePasswordVisibility,
            updateWordCount,
        });
