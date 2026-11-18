// Просмотры: один запрос на историю за сессию, и только если колонка уже есть.
import { api } from '../../shared/lib/api.js';

const VIEWS_KEY = 'shersh_viewed';

export function trackView(post) {
    if (!post || post.views == null) return;
    let seen;
    try { seen = JSON.parse(sessionStorage.getItem(VIEWS_KEY) || '[]'); } catch (e) { seen = []; }
    if (!Array.isArray(seen)) seen = [];
    if (seen.includes(post.id)) return;
    seen.push(post.id);
    try { sessionStorage.setItem(VIEWS_KEY, JSON.stringify(seen)); } catch (e) { /* приватный режим */ }
    api('/api/posts/' + post.id + '/view', { method: 'POST' })
        .then((data) => { if (data && typeof data.views === 'number') post.views = data.views; })
        .catch(() => { /* просмотры не критичны */ });
}
