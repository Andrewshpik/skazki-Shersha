// Модальные окна: свои диалоги вместо alert/confirm/prompt, просмотр картинки,
// блокировка прокрутки фона и фокус-ловушка.

export function syncBodyScrollLock() {
    const anyOpen = Array.from(document.querySelectorAll('.modal-overlay'))
        .some(m => getComputedStyle(m).display === 'flex');
    document.body.style.overflow = anyOpen ? 'hidden' : '';
}

export function topVisibleModal() {
    const modals = Array.from(document.querySelectorAll('.modal-overlay'))
        .filter(m => getComputedStyle(m).display !== 'none');
    return modals.length ? modals[modals.length - 1] : null;
}

export function openUiDialog(opts) {
    const o = Object.assign({
        title: '', text: '', value: '', placeholder: '', inputLabel: '',
        multiline: false, hasInput: false, okText: 'OK', cancelText: 'Отмена',
        danger: false, requireText: null
    }, opts || {});

    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay ui-dialog';
        overlay.style.display = 'flex';

        const box = document.createElement('div');
        box.className = 'modal-content';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', o.title);

        const h = document.createElement('h2');
        h.style.textAlign = 'center';
        h.textContent = o.title;
        box.appendChild(h);

        if (o.text) {
            const p = document.createElement('p');
            p.className = 'ui-dialog-text';
            p.textContent = o.text;
            box.appendChild(p);
        }

        let field = null;
        const err = document.createElement('div');
        err.className = 'form-error';

        if (o.hasInput) {
            if (o.inputLabel) {
                const lbl = document.createElement('label');
                lbl.textContent = o.inputLabel;
                box.appendChild(lbl);
            }
            field = document.createElement(o.multiline ? 'textarea' : 'input');
            if (o.multiline) { field.rows = 3; } else { field.type = 'text'; }
            field.value = o.value || '';
            field.placeholder = o.placeholder || '';
            field.className = 'ui-dialog-input';
            box.appendChild(field);
            box.appendChild(err);
        }

        const btns = document.createElement('div');
        btns.className = 'modal-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-cancel';
        cancelBtn.textContent = o.cancelText;

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn' + (o.danger ? ' btn-delete' : '');
        okBtn.textContent = o.okText;

        btns.appendChild(cancelBtn);
        btns.appendChild(okBtn);
        box.appendChild(btns);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        syncBodyScrollLock();

        const close = (result) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
            syncBodyScrollLock();
            resolve(result);
        };
        const fail = (m) => { err.textContent = m; err.style.display = 'block'; };

        const accept = () => {
            if (!field) return close(true);
            const v = field.value;
            if (o.requireText !== null && (v || '').trim().toUpperCase() !== o.requireText.toUpperCase()) {
                return fail('Введите «' + o.requireText + '» — иначе действие отменится');
            }
            return close(v);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(o.hasInput ? null : false); }
            else if (e.key === 'Enter' && (!field || !o.multiline)) { e.preventDefault(); accept(); }
        };

        okBtn.addEventListener('click', accept);
        cancelBtn.addEventListener('click', () => close(o.hasInput ? null : false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(o.hasInput ? null : false); });
        document.addEventListener('keydown', onKey, true);

        setTimeout(() => { (field || okBtn).focus(); if (field && field.select) field.select(); }, 30);
    });
}

export function uiConfirm(title, text, opts) {
    return openUiDialog(Object.assign({ title, text, okText: 'Подтвердить' }, opts || {}));
}

export function uiPrompt(title, opts) {
    return openUiDialog(Object.assign({ title, hasInput: true, okText: 'Сохранить' }, opts || {}));
}

export function openImageModal(src) {
    const img = document.getElementById('fullImage');
    const modal = document.getElementById('imageModal');
    if (!img || !modal) return;
    img.src = src;
    modal.style.display = 'flex';
}

export function closeImageModal() {
    const modal = document.getElementById('imageModal');
    if (!modal) return;
    modal.style.display = 'none';
}
