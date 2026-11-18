// Работа с файлами: проверка, сжатие и загрузка в Storage.
import { MAX_UPLOAD_BYTES } from '../config.js';
import { api } from './api.js';

export function validateImageFile(file) {
    if (!file) return 'Файл не выбран';
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type || '')) {
        return 'Можно загрузить только JPG, PNG, WEBP или GIF';
    }
    if (file.size > MAX_UPLOAD_BYTES) {
        return `Файл слишком большой (${(file.size / 1048576).toFixed(1)} МБ). Максимум 12 МБ`;
    }
    return null;
}

export function compressImage(file, maxWidth = 1280, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxWidth / img.width);
                const width = Math.round(img.width * scale);
                const height = Math.round(img.height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
            img.src = event.target.result;
        };
        reader.onerror = () => reject(new Error('Ошибка чтения файла'));
        reader.readAsDataURL(file);
    });
}

export async function uploadImage(base64Data) {
    const data = await api('/api/upload', {
        method: 'POST',
        body: JSON.stringify({ image: base64Data }),
    });
    return data.url;
}

export async function uploadAudio(dataUrl) {
    const data = await api('/api/audio', {
        method: 'POST',
        body: JSON.stringify({ audio: dataUrl }),
    });
    return data.url;
}
