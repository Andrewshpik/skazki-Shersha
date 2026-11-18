// Поиск по ленте: фильтрация карточек и подсветка совпадений.
import { normalizeForSearch } from '../../shared/lib/format.js';

let searchTimer = null;

export function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => filterPosts(true), 250);
}

export function filterPosts(allowHighlight) {
    const input = document.getElementById('searchInput');
    const raw = input ? input.value.trim() : '';
    const query = normalizeForSearch(raw);
    const postCards = document.querySelectorAll('.post-card');
    let visible = 0;

    postCards.forEach((card) => {
        const haystack = normalizeForSearch([
            card.dataset.title,
            card.dataset.text,
            card.dataset.author,
            card.dataset.tags,
        ].join(' '));
        const match = !query || haystack.includes(query);
        card.style.display = match ? 'block' : 'none';
        if (match) visible++;
        if (allowHighlight) highlightInCard(card, raw);
    });

    updateSearchStatus(query ? visible : null, raw);
}

function updateSearchStatus(count, raw) {
    let element = document.getElementById('searchStatus');
    if (!element) {
        element = document.createElement('div');
        element.id = 'searchStatus';
        element.className = 'search-status';
        const bar = document.getElementById('searchContainer');
        if (bar) bar.appendChild(element);
    }
    if (count === null) {
        element.textContent = '';
        element.style.display = 'none';
        return;
    }
    element.style.display = 'block';
    element.textContent = count > 0
        ? `Найдено историй: ${count} по запросу «${raw}»`
        : `По запросу «${raw}» ничего не найдено`;
}

// Подсветка совпадений в заголовке, тексте, авторе и тегах
function highlightInCard(card, raw) {
    const query = String(raw || '').trim();
    const targets = card.querySelectorAll('h2, .post-content, .author-name, .hint-tag');
    targets.forEach((node) => {
        clearHighlight(node);
        if (!query || query.length < 2) return;
        highlightNode(node, query);
    });
}

function clearHighlight(node) {
    node.querySelectorAll('mark').forEach((mark) => {
        mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
    });
    if (node.parentNode) node.parentNode.normalize();
}

function highlightNode(node, query) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let nodeRef;
    while ((nodeRef = walker.nextNode())) textNodes.push(nodeRef);

    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    textNodes.forEach((textNode) => {
        const text = textNode.nodeValue;
        if (!pattern.test(text)) return;
        pattern.lastIndex = 0;

        const fragment = document.createDocumentFragment();
        let last = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
            const mark = document.createElement('mark');
            mark.className = 'search-hit';
            mark.textContent = match[0];
            fragment.appendChild(mark);
            last = match.index + match[0].length;
        }
        fragment.appendChild(document.createTextNode(text.slice(last)));
        textNode.parentNode.replaceChild(fragment, textNode);
    });
}

window.onSearchInput = onSearchInput;
