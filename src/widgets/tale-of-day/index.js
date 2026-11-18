// Виджет «Сказка дня»: одна история на сутки, выбор детерминированный по дате.
import { getPosts } from '../../shared/state.js';
import { escapeHTML, readingTime } from '../../shared/lib/format.js';
import { postPageUrl } from '../../shared/lib/urls.js';

export function taleOfDayIndex() {
    const posts = getPosts();
    if (!posts.length) return -1;
    const now = new Date();
    const seed = Number(
        '' + now.getFullYear()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
    );
    return seed % posts.length;
}

export function renderTaleOfDay() {
    const box = document.getElementById('taleOfDay');
    if (!box) return;
    const posts = getPosts();
    const index = taleOfDayIndex();
    if (index < 0) {
        box.style.display = 'none';
        return;
    }
    const post = posts[index];
    const excerpt = (post.text || '').replace(/\s+/g, ' ').trim();
    const short = excerpt.length > 220 ? excerpt.slice(0, 220).trimEnd() + '…' : excerpt;
    box.innerHTML = `
        <span class="tale-of-day__label">🌙 Сказка дня</span>
        <h2>${escapeHTML(post.title)}</h2>
        <div class="tale-of-day__meta">${escapeHTML(post.author)} · ⏱ ${readingTime(post.text)}</div>
        <p>${escapeHTML(short)}</p>
        <div class="tale-of-day__actions">
            <button class="btn btn-soft" onclick="openTaleOfDay(${index})">Читать</button>
            <a class="btn btn-soft" href="${postPageUrl(post.id)}" target="_blank" rel="noopener">Страница истории</a>
        </div>`;
    box.style.display = 'block';
}

window.openTaleOfDay = function (index) {
    window.openComments(index);
};
