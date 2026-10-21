'use strict';

/**
 * whereUid — UID ОДНОЙ записи из условия `where` операции.
 *
 * Зачем отдельный модуль (найдено живым прогоном 15.10.2026). Проектный RLS
 * переписывает `where` в `{ [Op.and]: [исходное, фильтр] }` — у такого объекта
 * одни ключи-символы, и прямое `request.where.UID` у любого пользователя, кроме
 * администратора, пусто. Читавшие его так молча ничего не делали: сохранение
 * документа не ставило его в очередь проведения, смена даты не переназначала
 * момент `seq`, представление строилось из одних изменённых полей. У
 * администратора всё работало — потому и не было видно.
 *
 * Ищем только внутри `Op.and`: каждая его часть обязана выполняться, значит
 * найденный там UID и есть запись операции. `Op.or` не сужает до одной записи,
 * а RLS кладёт туда свои фильтры — для `organizations` это `{ UID: <своя
 * организация> }`, и найти его значило бы принять фильтр за запись.
 */

const { Op } = require('sequelize');

/**
 * @param {object} where
 * @returns {string|null}
 */
function uidOf(where) {
    if (!where || typeof where !== 'object') return null;
    const own = where.UID || where.uid;
    if (typeof own === 'string') return own;
    const parts = where[Op.and];
    if (Array.isArray(parts)) {
        for (const part of parts) {
            const u = uidOf(part);
            if (u) return u;
        }
    } else if (parts && typeof parts === 'object') {
        return uidOf(parts);
    }
    return null;
}

module.exports = { uidOf };
