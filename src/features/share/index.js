// Поделиться историей: нативный шер и копирование ссылки на страницу истории.
import { getPosts } from '../../shared/state.js';
import { postPageUrl } from '../../shared/lib/urls.js';

let notify = (message, isError) => console.info(message, isError || '');

export function setToastHandler(handler) {
    if (typeof handler === 'function') notify = handler;
}

export function copyPostLink(id) {
    navigator.clipboard.writeText(postPageUrl(id))
        .then(() => notify('Ссылка на пост скопирована'))
        .catch(() => notify('Не удалось скопировать', true));
}

export function sharePost(index) {
    const post = getPosts()[index];
    if (!post) return;

    if (navigator.share) {
        navigator.share({ title: post.title, text: String(post.text || '').slice(0, 200) }).catch(() => {});
        return;
    }

    const url = location.origin + location.pathname + '#post-' + post.id;
    navigator.clipboard.writeText(url)
        .then(() => notify('Ссылка скопирована!'))
        .catch(() => notify('Не удалось скопировать', true));
}

window.copyPostLink = copyPostLink;
window.sharePost = sharePost;
