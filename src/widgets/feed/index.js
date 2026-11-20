// Лента историй: карточка поста, фильтры по тегу и авторам, «Показать ещё».
import { escapeHTML, formatDate, readingTime } from '../../shared/lib/format.js';

function browserAvatar(author) {
    return `<div class="post-avatar" onclick='openAuthorProfile(&quot;${escapeHTML(author)}&quot;)'>👤</div>`;
}

export function createPostCard(post, index, opts = {}) {
    const {
        userData = {},
        usersMap = {},
        newCommentsBadge = () => ''
    } = opts;

    const postElement = document.createElement('article');
    postElement.className = 'post-card';
    postElement.id = 'post-' + post.id;
    postElement.dataset.author = post.author || '';
    postElement.dataset.tags = (post.tags || []).join(' ');
    postElement.dataset.title = post.title || '';
    postElement.dataset.text = post.text || '';

    const authorData = usersMap[post.author];
    const avatarSrc = authorData && authorData.avatar ? authorData.avatar : null;
    const avatarHTML = avatarSrc
        ? `<img src="${avatarSrc}" class="post-avatar" alt="Аватар ${escapeHTML(post.author)}" onclick='openAuthorProfile(&quot;${escapeHTML(post.author)}&quot;)'>`
        : browserAvatar(post.author);

    const isAuthor = userData.name === post.author && !userData.isGuest;
    const canDelete = isAuthor || userData.is_admin;
    const controlsHTML = `
                    <div class="post-controls">
                        ${isAuthor ? `<button class="edit-post-btn" onclick="editPost(${post.id})" title="Редактировать" aria-label="Редактировать историю">✏️</button>` : ''}
                        ${canDelete ? `<button class="delete-post-btn" onclick="deletePost(${post.id})" title="${userData.is_admin && !isAuthor ? 'Удалить (админ)' : 'Удалить'}" aria-label="Удалить историю">🗑️</button>` : ''}
                    </div>
                `;

    const imageHTML = post.image
        ? `<img src="${post.image}" class="post-image" alt="Изображение к истории «${escapeHTML(post.title)}»" loading="lazy" onclick="openImageModal('${post.image}')">`
        : '';
    const tagsHTML = (post.tags && post.tags.length)
        ? `<div class="post-tags">${post.tags.map(t => `<span class="hint-tag" onclick="filterByTag('${escapeHTML(t)}')">#${escapeHTML(t)}</span>`).join('')}</div>`
        : '';

    const commentCount = post.comments ? post.comments.length : 0;

    postElement.innerHTML = `
                    <div class="post-header-row">
                        <h2>${escapeHTML(post.title)}</h2>
                        ${controlsHTML}
                    </div>                    <div class="post-meta">
                        ${avatarHTML}
                        <span>Автор: <a href="#" class="author-name" onclick='openAuthorProfile(&quot;${escapeHTML(post.author)}&quot;)'>${escapeHTML(post.author)}</a></span>
                        <span>•</span>
                        <span>${formatDate(post.date)}</span>
                        <span>•</span>
                        <span title="Примерное время чтения">⏱ ${readingTime(post.text)}</span>
                        ${post.views != null ? `<span>•</span><span title="Просмотры">👁 ${post.views}</span>` : ''}
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
                        <button class="action-btn" onclick="speakPost(${index})" title="${post.audio ? 'Слушать озвучку автора' : 'Слушать сказку'}" aria-label="Слушать сказку">
                            ${post.audio ? '🎧 Слушать запись' : '🔊 Слушать'}
                        </button>
                        <button class="action-btn offline-btn" data-post="${post.id}" onclick="toggleOffline(${post.id})" title="Сохранить сказку для чтения без интернета" aria-label="Сохранить для чтения без интернета">
                            📥 Офлайн
                        </button>
                        ${!userData.isGuest && userData.name ? `<button class="action-btn" onclick="reportPost(${post.id})" title="Пожаловаться" aria-label="Пожаловаться на историю">🚩</button>` : ''}
                    </div>
                `;

    return postElement;
}

export function renderFeed(container, items, opts = {}) {
    const {
        userData = {},
        usersMap = {},
        activeTag = null,
        myOnly = false,
        myAuthors = null,
        visibleCount = Infinity,
        newCommentsBadge = () => '',
        trackView = () => {},
        onMore = null,
        afterRender = null
    } = opts;

    container.innerHTML = '';

    if (!items.length) {
        container.innerHTML = `
                    <div class="empty-feed">
                        <h3>Здесь пока пусто...</h3>
                        <p>Стань первым, кто расскажет сказку Шершу!</p>
                        <button class="btn" onclick="document.getElementById('addPostBtn').click()">Добавить историю</button>
                    </div>
                `;
        return 0;
    }

    const limit = Math.min(visibleCount, items.length);
    let shown = 0;

    items.slice(0, limit).forEach((post, index) => {
        if (activeTag && !(post.tags && post.tags.includes(activeTag))) return;
        if (myOnly && post.author !== userData.name) return;
        if (myAuthors && !myAuthors.has(post.author)) return;
        shown++;
        trackView(post);
        container.appendChild(createPostCard(post, index, { userData, usersMap, newCommentsBadge }));
    });

    if (visibleCount < items.length && onMore) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'btn';
        moreBtn.textContent = 'Показать ещё (' + (items.length - visibleCount) + ')';
        moreBtn.style.display = 'block';
        moreBtn.style.margin = '0 auto 20px';
        moreBtn.onclick = onMore;
        container.appendChild(moreBtn);
    }

    if (afterRender) afterRender();
    return shown;
}
