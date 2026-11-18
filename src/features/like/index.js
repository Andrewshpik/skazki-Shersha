// Лайки: переключение отметки и синхронизация с сервером.
import { api } from '../../shared/lib/api.js';
import { POSTS_CACHE_KEY } from '../../shared/config.js';
import { getPosts, getUser } from '../../shared/state.js';

const deps = {
    toast: () => {},
    render: () => {},
    getLikedSet: () => null,
};

export async function toggleLike(index) {
    const posts = getPosts();
    const post = posts[index];
    const user = getUser() || {};
    if (!post) return;

    if (!user.name || user.isGuest) {
        deps.toast('Гости не могут ставить лайки!', true);
        return;
    }

    try {
        const data = await api('/api/posts/' + post.id + '/like', {
            method: 'POST',
            body: JSON.stringify({ user: user.name }),
        });
        post.isLiked = data.status === 'liked';
        post.likes = data.likes;

        const likedSet = deps.getLikedSet();
        if (likedSet) {
            if (post.isLiked) likedSet.add(post.id);
            else likedSet.delete(post.id);
        }

        localStorage.setItem(POSTS_CACHE_KEY, JSON.stringify(posts));
        deps.render();
    } catch (e) {
        deps.toast(e.message, true);
    }
}

export function initLikes(options = {}) {
    Object.assign(deps, options);
    window.toggleLike = toggleLike;
}
