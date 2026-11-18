// Жалобы на истории и комментарии: диалог причины и отправка на сервер.
import { api } from '../../shared/lib/api.js';
import { getPosts, getUser } from '../../shared/state.js';

const deps = {
    prompt: async () => null,
    toast: (message, isError) => console.info(message, isError || ''),
};

async function askReason(title, placeholder) {
    const answer = await deps.prompt(title, {
        text: 'Расскажи, что не так — модератор посмотрит.',
        inputLabel: 'Причина (необязательно):',
        placeholder,
        multiline: true,
        okText: 'Отправить',
    });
    return answer === null ? null : answer.trim();
}

export async function reportPost(id) {
    const post = getPosts().find((item) => item.id === id);
    if (!post) return;

    const reason = await askReason('Жалоба на историю', 'Например: оскорбления');
    if (reason === null) return;

    const user = getUser() || {};
    try {
        await api('/api/report', {
            method: 'POST',
            body: JSON.stringify({
                type: 'post',
                target_id: String(id),
                target_author: post.author,
                reporter: user.name,
                reason,
            }),
        });
        deps.toast('Жалоба отправлена. Спасибо!');
    } catch (e) {
        deps.toast(e.message, true);
    }
}

export async function reportComment(commentId, author) {
    const reason = await askReason('Жалоба на комментарий', 'Например: спам');
    if (reason === null) return;

    const user = getUser() || {};
    try {
        await api('/api/report', {
            method: 'POST',
            body: JSON.stringify({
                type: 'comment',
                target_id: String(commentId),
                target_author: author,
                reporter: user.name,
                reason,
            }),
        });
        deps.toast('Жалоба отправлена. Спасибо!');
    } catch (e) {
        deps.toast(e.message, true);
    }
}

export function initReports(options = {}) {
    Object.assign(deps, options);
    window.reportPost = reportPost;
    window.reportComment = reportComment;
}
