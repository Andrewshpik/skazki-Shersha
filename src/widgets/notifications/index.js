// Виджет уведомлений: комментарии, ответы, упоминания и новые лайки.
// Собирается из уже загруженной ленты — отдельной таблицы не нужно.
import { getPosts, getUser } from '../../shared/state.js';
import { escapeHTML } from '../../shared/lib/format.js';

const NOTIF_KEY = 'shersh_notif_seen_at';
const NOTIF_LIKES_KEY = 'shersh_notif_likes';

function notifSeenAt() {
    const seen = Date.parse(localStorage.getItem(NOTIF_KEY) || '');
    return Number.isFinite(seen) ? seen : 0;
}

function seenLikes() {
    try { return JSON.parse(localStorage.getItem(NOTIF_LIKES_KEY) || '{}') || {}; } catch (e) { return {}; }
}

function buildNotifications() {
    const posts = getPosts();
    const user = getUser() || {};
    const me = user.name;
    if (!me || user.isGuest || !posts.length) return [];

    const myNick = String(user.nickname || '').toLowerCase();
    const myCommentIds = new Set();
    posts.forEach((post) => (post.comments || []).forEach((comment) => {
        if (comment.author === me) myCommentIds.add(comment.id);
    }));

    const likesSnapshot = seenLikes();
    const items = [];

    posts.forEach((post) => {
        const minePost = post.author === me;
        (post.comments || []).forEach((comment) => {
            if (!comment || comment.author === me) return;
            const text = String(comment.text || '').toLowerCase();
            const mentioned = text.includes('@' + me.toLowerCase()) || (myNick.length > 2 && text.includes(myNick));
            if (minePost) {
                items.push({ icon: '💬', kind: 'Комментарий', text: `${comment.author} оставил комментарий`,
                             post, date: comment.date, action: 'comments' });
            }
            if (mentioned) {
                items.push({ icon: '📣', kind: 'Упоминание', text: `${comment.author} упомянул вас`,
                             post, date: comment.date, action: 'comments' });
            }
            if (comment.parent_id && myCommentIds.has(comment.parent_id)) {
                items.push({ icon: '↩️', kind: 'Ответ', text: `${comment.author} ответил на ваш комментарий`,
                             post, date: comment.date, action: 'comments' });
            }
        });
        if (minePost) {
            const previous = Number(likesSnapshot[post.id] || 0);
            if ((post.likes || 0) > previous) {
                items.push({ icon: '👍', kind: 'Лайки', text: `новых лайков: ${post.likes - previous}`,
                             post, date: post.date, action: 'post' });
            }
        }
    });

    const seenAt = notifSeenAt();
    items.forEach((item) => { item.unread = (Date.parse(item.date) || 0) > seenAt; });
    items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    return items;
}

export function updateBell() {
    const bellBtn = document.getElementById('bellBtn');
    const bellBadge = document.getElementById('bellBadge');
    const user = getUser() || {};
    if (!bellBtn || !user.name || user.isGuest) return;

    const unread = buildNotifications().filter((item) => item.unread).length;
    if (unread > 0) {
        bellBadge.textContent = unread > 99 ? '99+' : unread;
        bellBadge.style.display = 'flex';
    } else {
        bellBadge.style.display = 'none';
    }
}

function markNotificationsRead() {
    const user = getUser() || {};
    localStorage.setItem(NOTIF_KEY, new Date().toISOString());
    const snapshot = {};
    getPosts().filter((post) => post.author === user.name)
        .forEach((post) => { snapshot[post.id] = post.likes || 0; });
    try { localStorage.setItem(NOTIF_LIKES_KEY, JSON.stringify(snapshot)); } catch (e) { /* приватный режим */ }
    const badge = document.getElementById('bellBadge');
    if (badge) badge.style.display = 'none';
}

function renderNotifications() {
    const list = document.getElementById('notifList');
    if (!list) return;

    const items = buildNotifications();
    window.__notifItems = items;

    if (!items.length) {
        list.innerHTML = '<p style="text-align:center;color:#888;">Пока тихо. Здесь появятся комментарии, ответы, упоминания и новые лайки.</p>';
        return;
    }
    list.innerHTML = items.map((item, index) => `
        <button type="button" class="notif-item${item.unread ? ' is-unread' : ''}" onclick="openNotification(${index})">
            <span class="notif-icon" aria-hidden="true">${item.icon}</span>
            <span class="notif-body">
                <span class="notif-kind">${item.kind}</span>
                <span class="notif-text">${escapeHTML(item.text)}</span>
                <span class="notif-post">«${escapeHTML(item.post.title)}»</span>
            </span>
        </button>`).join('');
}

function openNotification(index) {
    const item = (window.__notifItems || [])[index];
    if (!item) return;

    const modal = document.getElementById('notifModal');
    if (modal) modal.style.display = 'none';

    if (item.action === 'comments') {
        const postIndex = getPosts().findIndex((post) => post.id === item.post.id);
        if (postIndex >= 0 && typeof window.openComments === 'function') {
            window.openComments(postIndex);
            return;
        }
    }
    if (typeof window.showPage === 'function') window.showPage('feed');
    if (typeof window.scrollToPost === 'function') window.scrollToPost(item.post.id);
}

export function initNotifications() {
    window.openNotification = openNotification;

    const bellBtn = document.getElementById('bellBtn');
    if (bellBtn) {
        bellBtn.addEventListener('click', () => {
            renderNotifications();
            markNotificationsRead();
            const modal = document.getElementById('notifModal');
            if (modal) modal.style.display = 'flex';
        });
    }

    const closeBtn = document.getElementById('closeNotifBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            const modal = document.getElementById('notifModal');
            if (modal) modal.style.display = 'none';
            updateBell();
        });
    }
}
