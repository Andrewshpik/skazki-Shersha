// Офлайн-чтение: кладём страницу истории в отдельный кеш браузера.
// Service worker отдаёт сохранённую копию раньше сети.
import { OFFLINE_CACHE } from '../../shared/config.js';
import { postPageUrl } from '../../shared/lib/urls.js';

let notify = (message) => console.info(message);

export function setToastHandler(handler) {
    if (typeof handler === 'function') notify = handler;
}

export async function isSavedOffline(id) {
    if (!('caches' in window)) return false;
    try {
        const cache = await caches.open(OFFLINE_CACHE);
        return !!(await cache.match(postPageUrl(id)));
    } catch (e) {
        return false;
    }
}

export async function refreshOfflineButtons() {
    const buttons = document.querySelectorAll('.offline-btn');
    for (const button of buttons) {
        const saved = await isSavedOffline(button.dataset.post);
        button.textContent = saved ? '✓ Офлайн' : '📥 Офлайн';
        button.classList.toggle('is-saved', saved);
        button.title = saved
            ? 'Сказка сохранена — откроется без интернета'
            : 'Сохранить сказку для чтения без интернета';
    }
}

export async function toggleOffline(id) {
    if (!('caches' in window)) {
        notify('Браузер не умеет сохранять офлайн', true);
        return;
    }
    const url = postPageUrl(id);
    try {
        const cache = await caches.open(OFFLINE_CACHE);
        const saved = await cache.match(url);
        if (saved) {
            await cache.delete(url);
            notify('Сохранённая копия удалена');
        } else {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error('Страница истории ещё не собрана — попробуйте позже');
            await cache.put(url, response.clone());
            notify('Сказка сохранена — откроется без интернета');
        }
        await refreshOfflineButtons();
    } catch (e) {
        notify(e.message || 'Не удалось сохранить', true);
    }
}

window.toggleOffline = toggleOffline;
