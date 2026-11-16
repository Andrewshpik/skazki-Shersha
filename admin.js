const API = 'https://shersh-auth.de1.netrun.io';

        const state = { me: null, data: null };

        function showToast(message, isError = false) {
            const box = document.getElementById('toasts');
            const toast = document.createElement('div');
            toast.className = 'toast' + (isError ? ' error' : '');
            toast.setAttribute('role', isError ? 'alert' : 'status');
            toast.textContent = message;
            box.appendChild(toast);
            setTimeout(() => toast.remove(), 3200);
        }

        async function api(path, options = {}) {
            const token = localStorage.getItem('shersh_token') || '';
            const res = await fetch(API + path, {
                method: options.method || 'GET',
                headers: Object.assign(
                    { 'Content-Type': 'application/json' },
                    token ? { Authorization: 'Bearer ' + token } : {}
                ),
                body: options.body ? JSON.stringify(options.body) : undefined,
                cache: 'no-store'
            });
            const text = await res.text();
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
            if (!res.ok) throw new Error((data && data.error) || 'Ошибка ' + res.status);
            return data;
        }

        function openUiDialog(opts) {
            const o = Object.assign({
                title: '', text: '', value: '', placeholder: '', inputLabel: '',
                multiline: false, hasInput: false, okText: 'OK', cancelText: 'Отмена', danger: false
            }, opts || {});

            return new Promise(resolve => {
                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay';

                const box = document.createElement('div');
                box.className = 'modal-content';
                box.setAttribute('role', 'dialog');
                box.setAttribute('aria-modal', 'true');

                const h = document.createElement('h2');
                h.textContent = o.title;
                box.appendChild(h);

                if (o.text) {
                    const p = document.createElement('p');
                    p.className = 'ui-dialog-text';
                    p.textContent = o.text;
                    box.appendChild(p);
                }

                let field = null;
                if (o.hasInput) {
                    if (o.inputLabel) {
                        const lbl = document.createElement('label');
                        lbl.textContent = o.inputLabel;
                        box.appendChild(lbl);
                    }
                    field = document.createElement(o.multiline ? 'textarea' : 'input');
                    if (o.multiline) field.rows = 3;
                    else field.type = 'text';
                    field.className = 'ui-dialog-input';
                    field.value = o.value || '';
                    field.placeholder = o.placeholder || '';
                    box.appendChild(field);
                }

                const btns = document.createElement('div');
                btns.className = 'modal-buttons';

                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'btn btn-ghost';
                cancelBtn.textContent = o.cancelText;

                const okBtn = document.createElement('button');
                okBtn.type = 'button';
                okBtn.className = 'btn' + (o.danger ? ' btn-danger' : '');
                okBtn.textContent = o.okText;

                btns.appendChild(cancelBtn);
                btns.appendChild(okBtn);
                box.appendChild(btns);
                overlay.appendChild(box);
                document.body.appendChild(overlay);

                const close = (result) => {
                    overlay.remove();
                    document.removeEventListener('keydown', onKey, true);
                    resolve(result);
                };
                const accept = () => close(field ? field.value : true);
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

        const uiConfirm = (title, text, opts) => openUiDialog(Object.assign({ title, text, okText: 'Подтвердить' }, opts || {}));
        const uiPrompt = (title, opts) => openUiDialog(Object.assign({ title, hasInput: true, okText: 'Сохранить' }, opts || {}));

        function escapeHTML(str) {
            return String(str == null ? '' : str)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function formatDate(value) {
            if (!value) return '';
            const d = new Date(value);
            if (isNaN(d)) return '';
            return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        }

        function readMe() {
            try {
                const me = JSON.parse(localStorage.getItem('shersh_user') || 'null');
                return me && me.is_admin ? me : null;
            } catch (e) {
                return null;
            }
        }

        function row({ title, badges = [], meta = '', text = '', actions = '' }) {
            const badgesHTML = badges.map(b => `<span class="badge ${b.cls || ''}">${escapeHTML(b.label)}</span>`).join('');
            return `<div class="row">
                <div class="row-head"><span class="row-title">${escapeHTML(title)}</span>${badgesHTML}${meta ? `<span class="meta">${meta}</span>` : ''}</div>
                ${text ? `<div class="text">${escapeHTML(text)}</div>` : ''}
                ${actions ? `<div class="actions">${actions}</div>` : ''}
            </div>`;
        }

        function renderReports() {
            const list = state.data.reports || [];
            const box = document.getElementById('panel-reports');
            if (!list.length) { box.innerHTML = '<div class="empty">Жалоб нет — красота.</div>'; return; }
            box.innerHTML = list.map(r => {
                const typeLabel = r.type === 'post' ? 'История' : (r.type === 'comment' ? 'Комментарий' : 'Пользователь');
                const badges = [{ label: typeLabel }];
                if (r.gone) badges.push({ label: 'уже удалено', cls: 'gone' });
                const link = r.type === 'post' && !r.gone
                    ? `<a class="btn btn-ghost btn-small" href="index.html#post-${encodeURIComponent(r.target_id)}" target="_blank" rel="noopener">Открыть</a>`
                    : '';
                const banBtn = r.target_author
                    ? `<button class="btn btn-danger btn-small" data-act="ban" data-name="${escapeHTML(r.target_author)}">Забанить</button>`
                    : '';
                const delTarget = (!r.gone && r.type === 'post')
                    ? `<button class="btn btn-danger btn-small" data-act="delpost" data-id="${escapeHTML(r.target_id)}">Удалить историю</button>`
                    : '';
                const delTargetComment = (!r.gone && r.type === 'comment')
                    ? `<button class="btn btn-danger btn-small" data-act="delcomment" data-id="${escapeHTML(r.target_id)}">Удалить комментарий</button>`
                    : '';
                const actions = `${link}
                    <button class="btn btn-ghost btn-small" data-act="delreport" data-id="${escapeHTML(r.id)}">Жалоба решена</button>
                    ${banBtn}${delTarget}${delTargetComment}`;
                return row({
                    title: r.target_author ? 'На ' + r.target_author : 'На пользователя',
                    badges,
                    meta: formatDate(r.created_at || r.report_date || r.date),
                    text: (r.reason ? 'Причина: ' + r.reason + '\n' : '') + (r.preview ? 'Содержание: ' + r.preview : ''),
                    actions
                });
            }).join('');
        }

        function renderUsers() {
            const list = state.data.users || [];
            const box = document.getElementById('panel-users');
            if (!list.length) { box.innerHTML = '<div class="empty">Пользователей нет.</div>'; return; }
            box.innerHTML = list.map(u => {
                const badges = [];
                if (u.is_admin) badges.push({ label: 'админ', cls: 'admin' });
                if (u.banned) badges.push({ label: 'забанен', cls: 'banned' });
                if (u.telegram) badges.push({ label: 'Telegram' });
                const banBtn = u.banned
                    ? `<button class="btn btn-ghost btn-small" data-act="unban" data-name="${escapeHTML(u.name)}">Разбанить</button>`
                    : `<button class="btn btn-danger btn-small" data-act="ban" data-name="${escapeHTML(u.name)}">Забанить</button>`;
                const adminBtn = `<button class="btn btn-ghost btn-small" data-act="toggleadmin" data-name="${escapeHTML(u.name)}" data-admin="${u.is_admin ? '1' : '0'}">${u.is_admin ? 'Снять админа' : 'Сделать админом'}</button>`;
                return row({
                    title: u.name + (u.nickname ? ' · ' + u.nickname : ''),
                    badges,
                    meta: `Историй: ${u.posts_count} · Комментариев: ${u.comments_count}`,
                    text: u.bio || '',
                    actions: banBtn + adminBtn
                });
            }).join('');
        }

        function renderBanned() {
            const list = state.data.banned || [];
            const box = document.getElementById('panel-banned');
            if (!list.length) { box.innerHTML = '<div class="empty">Забаненных нет.</div>'; return; }
            box.innerHTML = list.map(b => row({
                title: b.name,
                badges: [{ label: 'забанен', cls: 'banned' }],
                meta: formatDate(b.ban_date || b.created_at),
                text: b.reason || '',
                actions: `<button class="btn btn-ghost btn-small" data-act="unban" data-name="${escapeHTML(b.name)}">Разбанить</button>`
            })).join('');
        }

        function renderPosts() {
            const list = state.data.posts || [];
            const box = document.getElementById('panel-posts');
            if (!list.length) { box.innerHTML = '<div class="empty">Историй ещё нет.</div>'; return; }
            box.innerHTML = list.map(p => row({
                title: '№' + p.id + ' · ' + p.title,
                badges: [{ label: p.author }],
                meta: `${formatDate(p.date)} · лайков: ${p.likes}`,
                text: p.text,
                actions: `<a class="btn btn-ghost btn-small" href="index.html#post-${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Открыть</a>
                    <button class="btn btn-danger btn-small" data-act="ban" data-name="${escapeHTML(p.author)}">Забанить автора</button>
                    <button class="btn btn-danger btn-small" data-act="delpost" data-id="${escapeHTML(p.id)}">Удалить</button>`
            })).join('');
        }

        function renderComments() {
            const list = state.data.comments || [];
            const box = document.getElementById('panel-comments');
            if (!list.length) { box.innerHTML = '<div class="empty">Комментариев нет.</div>'; return; }
            box.innerHTML = list.map(c => row({
                title: '№' + c.id + ' · ' + c.author,
                badges: [{ label: 'к истории №' + c.post_id }],
                meta: formatDate(c.date),
                text: c.text,
                actions: `<a class="btn btn-ghost btn-small" href="index.html#post-${encodeURIComponent(c.post_id)}" target="_blank" rel="noopener">К истории</a>
                    <button class="btn btn-danger btn-small" data-act="ban" data-name="${escapeHTML(c.author)}">Забанить автора</button>
                    <button class="btn btn-danger btn-small" data-act="delcomment" data-id="${escapeHTML(c.id)}">Удалить</button>`
            })).join('');
        }

        function renderStats() {
            const s = state.data.stats || {};
            const items = [
                ['Пользователи', s.users], ['Истории', s.posts], ['Комментарии', s.comments],
                ['Жалобы', s.reports], ['Забанены', s.banned]
            ];
            document.getElementById('stats').innerHTML = items.map(([label, value]) =>
                `<div class="stat"><b>${value == null ? 0 : value}</b><span>${label}</span></div>`).join('');
            document.getElementById('cntReports').textContent = '(' + (s.reports || 0) + ')';
            document.getElementById('cntUsers').textContent = '(' + (s.users || 0) + ')';
            document.getElementById('cntBanned').textContent = '(' + (s.banned || 0) + ')';
            document.getElementById('cntPosts').textContent = '(' + (s.posts || 0) + ')';
            document.getElementById('cntComments').textContent = '(' + (s.comments || 0) + ')';
        }

        async function loadData() {
            const btn = document.getElementById('refreshBtn');
            btn.disabled = true;
            try {
                state.data = await api('/api/admin/overview?user=' + encodeURIComponent(state.me.name));
                renderStats();
                renderReports();
                renderUsers();
                renderBanned();
                renderPosts();
                renderComments();
            } catch (e) {
                showToast(e.message || 'Не удалось загрузить админку', true);
            } finally {
                btn.disabled = false;
            }
        }

        async function banUser(name) {
            const reason = await uiPrompt('Забанить пользователя', {
                text: name + ' больше не сможет писать на сайте.',
                inputLabel: 'Причина (видна только в админке):',
                placeholder: 'Например: спам',
                okText: 'Забанить',
                danger: true
            });
            if (reason === null) return;
            try {
                await api('/api/ban', { method: 'POST', body: { user: state.me.name, target: name, reason: reason.trim() } });
                showToast(name + ' забанен');
                await loadData();
            } catch (e) { showToast(e.message, true); }
        }

        async function unbanUser(name) {
            const ok = await uiConfirm('Разбанить?', name + ' снова сможет писать.', { okText: 'Разбанить' });
            if (!ok) return;
            try {
                await api('/api/ban', { method: 'DELETE', body: { user: state.me.name, target: name } });
                showToast(name + ' разбанен');
                await loadData();
            } catch (e) { showToast(e.message, true); }
        }

        async function toggleAdmin(name, isAdmin) {
            const ok = await uiConfirm(
                isAdmin ? 'Снять права админа?' : 'Выдать права админа?',
                name + (isAdmin ? ' потеряет доступ к админке.' : ' получит доступ к админке.'),
                { okText: isAdmin ? 'Снять' : 'Выдать', danger: isAdmin }
            );
            if (!ok) return;
            try {
                await api('/api/admin/user', { method: 'PATCH', body: { user: state.me.name, target: name, is_admin: !isAdmin } });
                showToast('Права обновлены');
                await loadData();
            } catch (e) { showToast(e.message, true); }
        }

        async function deleteReport(id) {
            try {
                await api('/api/reports/' + id, { method: 'DELETE', body: { user: state.me.name } });
                showToast('Жалоба закрыта');
                await loadData();
            } catch (e) { showToast(e.message, true); }
        }

        async function deletePost(id) {
            const ok = await uiConfirm('Удалить историю?', 'История исчезнет с сайта вместе с комментариями.', { okText: 'Удалить', danger: true });
            if (!ok) return;
            try {
                await api('/api/posts/' + id, { method: 'DELETE', body: { user: state.me.name } });
                showToast('История удалена');
                await loadData();
            } catch (e) { showToast(e.message, true); }
        }

        async function deleteComment(id) {
            const ok = await uiConfirm('Удалить комментарий?', 'Вернуть его не получится.', { okText: 'Удалить', danger: true });
            if (!ok) return;
            try {
                await api('/api/comments/' + id, { method: 'DELETE', body: { user: state.me.name } });
                showToast('Комментарий удалён');
                await loadData();
            } catch (e) { showToast(e.message, true); }
        }

        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
            });
        });

        document.querySelector('main').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'ban') banUser(btn.dataset.name);
            else if (act === 'unban') unbanUser(btn.dataset.name);
            else if (act === 'toggleadmin') toggleAdmin(btn.dataset.name, btn.dataset.admin === '1');
            else if (act === 'delreport') deleteReport(btn.dataset.id);
            else if (act === 'delpost') deletePost(btn.dataset.id);
            else if (act === 'delcomment') deleteComment(btn.dataset.id);
        });

        document.getElementById('refreshBtn').addEventListener('click', loadData);

        const themeSelect = document.getElementById('themeSelect');
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const savedTheme = localStorage.getItem('theme') || (prefersDark ? 'dark' : 'light');
        if (savedTheme !== 'light') document.body.setAttribute('data-theme', savedTheme);
        themeSelect.value = savedTheme;
        themeSelect.addEventListener('change', () => {
            if (themeSelect.value === 'light') document.body.removeAttribute('data-theme');
            else document.body.setAttribute('data-theme', themeSelect.value);
            localStorage.setItem('theme', themeSelect.value);
        });

        (async function init() {
            state.me = readMe();
            if (!state.me) {
                document.getElementById('gateText').textContent =
                    'Админка доступна только администратору. Войди на сайте под своим аккаунтом и вернись сюда.';
                return;
            }
            const admin = document.getElementById('admin');
            admin.style.display = 'block';
            document.getElementById('gate').style.display = 'none';
            document.getElementById('meLabel').textContent = '👤 ' + state.me.name;
            await loadData();
        })();
