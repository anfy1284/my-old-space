// Клиентские функции формы «Версия контекста переводчика» (messenger_translation_contexts).
//
// Файл загружается как исходный текст через loadScript() в apps/messenger/init.js;
// плейсхолдер __SERVER_SCRIPT__ заменяется на имя серверного скрипта мессенджера.
// Файл должен заканчиваться return { ... } — этого требует loadScript().

/**
 * «Восстановить эту версию»: текущей станет НОВАЯ версия с тем же содержимым.
 * Старые версии не переписываются — история нужна, чтобы откатиться ещё раз
 * (решение владельца 14.09.2026).
 */
async function restoreVersion(ev, ctx) {
    var form = ctx.form;
    var uidEntry = form._dataMap && form._dataMap['UID'];
    var contextId = uidEntry && uidEntry.value;
    if (!contextId) return;

    var ok = await showConfirm(__t('msg_trctx_restore_confirm'));
    if (!ok) return;

    var res = await callServer('__SERVER_SCRIPT__', 'restoreTranslationContext', { contextId: contextId });
    if (!res || res.error) {
        showAlert(__t('Error: ') + ((res && res.error) || ''));
        return;
    }
    showAlert(__t('msg_trctx_restored') + ' ' + res.version);
}

return { restoreVersion };
