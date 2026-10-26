export function byId(id) {
    return document.getElementById(id);
}

export function show(element, visible) {
    element.hidden = !visible;
}

export function setStatus(element, text, pulsing) {
    element.textContent = text;
    element.classList.toggle('pulse', pulsing);
    show(element, text !== '');
}

export function showError(element, text) {
    setStatus(element, text, false);
}

export function askConfirm(title, text, note, action) {
    byId('confirm-h').textContent = title;
    byId('confirm-text').textContent = text;
    byId('confirm-note').textContent = note;
    byId('confirm-ok').textContent = action;
    const dialog = byId('confirm');
    return new Promise(function (resolve) {
        dialog.addEventListener(
            'close',
            function () {
                resolve(dialog.returnValue === 'ok');
            },
            { once: true },
        );
        dialog.returnValue = '';
        dialog.showModal();
    });
}
