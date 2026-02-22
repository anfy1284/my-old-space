/**
 * dbGateway middleware уровня drive_forms.
 * 
 * Регистрирует пустой middleware на уровне 'forms'.
 * В будущем здесь можно добавить:
 *   - проверку сессии / авторизации
 *   - логирование операций
 *   - кэширование
 */

const dbGateway = require('../drive_root/dbGateway');

// Пустой middleware — пропускает всё дальше без изменений.
// Заглушка для будущей логики уровня drive_forms.
dbGateway.use('forms', async function formsMiddleware(request, next) {
    // TODO: проверка сессии, прав доступа на уровне форм
    return await next(request);
});

console.log('[drive_forms/dbGateway] Forms-level middleware registered');

module.exports = dbGateway;
