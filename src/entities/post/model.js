// Модель истории: разбор тегов и приведение ответа API к внутреннему виду.
export function extractTags(text) {
    const matches = String(text || '').match(/#([\wа-яёА-ЯЁ]+)/g) || [];
    const tags = [...new Set(matches.map((match) => match.slice(1).toLowerCase()))];
    return tags.slice(0, 6);
}

export function mapApiPost(row, likedSet = new Set()) {
    return {
        id: row.id,
        title: row.title,
        text: row.text,
        author: row.author,
        date: row.date,
        image: row.image,
        likes: row.likes || 0,
        views: row.views === undefined ? null : row.views,
        audio: row.audio || null,
        comments: row.comments || [],
        isLiked: likedSet.has(row.id),
        tags: extractTags(row.title + ' ' + row.text),
    };
}

export function mapApiPosts(rows, likedSet = new Set()) {
    return (rows || []).map((row) => mapApiPost(row, likedSet));
}

export function isMine(post, user) {
    return !!user && !user.isGuest && post.author === user.name;
}
