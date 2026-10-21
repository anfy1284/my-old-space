/**
 * Обработчики клика по уведомлению приложения `uniForm`.
 *
 * ФОРМАТ ФАЙЛА: это ТЕЛО ФУНКЦИИ, а не модуль — `return { … }` обязан стоять на
 * ВЕРХНЕМ уровне (ядро оборачивает содержимое в `new Function(code)`).
 *
 * В базе уведомления лежит ИМЯ функции, а не UID скрипта: `loadScript` выдаёт
 * свежий UID на каждом старте процесса, и вчерашний UID сегодня никуда не ведёт
 * (drive_root/notificationHandlers.js).
 */

/**
 * Открыть документ, о котором говорит уведомление.
 *
 * Уведомление о неудачном проведении бесполезно без документа: человек прочёл
 * «не удалось провести» — и следующее, что ему нужно, это сам документ. Полный
 * текст причины в уведомление не кладётся (он обрезан), он ждёт на форме, за
 * кнопкой «Показать причину».
 */
async function openDocument(params) {
    const p = params || {};
    if (!p.table || !p.uid) return;
    try {
        await window.MySpace.open('uniForm', {
            mode: 'record', tableName: p.table, recordID: p.uid
        });
    } catch (e) {
        console.error('[uniForm] документ из уведомления не открылся:', e && e.message);
    }
}

/**
 * Выполнить действие ОПОВЕЩЕНИЯ по документу (ТЗ «Оповещения по документам», §12).
 *
 * Пуш копирует текст строки и её действие, поэтому клик по уведомлению делает
 * ровно то же, что гиперссылка в панели формы. Разбор видов действия живёт в
 * ядре (`MySpace.alerts.run`) — вторая копия однажды повела бы себя иначе на том
 * же оповещении.
 *
 * Нет действия — открываем сам документ: уведомление без документа бесполезно,
 * человек прочёл «нужна корректировка» и первое, что ему нужно, это документ.
 */
async function runAlertAction(params) {
    const p = params || {};
    try {
        if (p.kind && window.MySpace && window.MySpace.alerts) {
            await window.MySpace.alerts.run(p);
            return;
        }
    } catch (e) {
        console.error('[uniForm] действие оповещения не выполнено:', e && e.message);
    }
    await openDocument({ table: p.documentTable, uid: p.documentUID });
}

return { openDocument, runAlertAction };
