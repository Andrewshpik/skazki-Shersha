// Список комментариев: группировка корней и ответов, карточка комментария.
import { escapeHTML, formatDate } from '../../shared/lib/format.js';

export function buildCommentNode(c, isReply, userData = {}) {
    const div = document.createElement('div');
    div.className = 'comment-item' + (isReply ? ' comment-reply' : '');

    const imageHTML = c.image
        ? `<img src="${c.image}" class="comment-image" alt="Фото в комментарии" loading="lazy" onclick="openImageModal('${c.image}')">`
        : '';
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

export function renderCommentsInto(listElement, comments, userData = {}) {
    listElement.innerHTML = '';

    if (!comments.length) {
        listElement.innerHTML = '<p style="color: #888; text-align: center;">Пока нет комментариев. Будь первым!</p>';
        return 0;
    }

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

    let rendered = 0;
    roots.forEach(c => {
        listElement.appendChild(buildCommentNode(c, false, userData));
        rendered++;
        (repliesByParent[String(c.id)] || []).forEach(r => {
            listElement.appendChild(buildCommentNode(r, true, userData));
            rendered++;
        });
    });
    orphanReplies.forEach(c => {
        listElement.appendChild(buildCommentNode(c, false, userData));
        rendered++;
    });
    return rendered;
}
