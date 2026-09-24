'use strict';

/**
 * coreWrite — ПРАВО ЯДРА ЗАПИСАТЬ ТО, ЧЕГО НЕ ВПРАВЕ ЗАПИСАТЬ НИКТО.
 *
 * Две записи в системе делает механизм, а не человек:
 *   1. движения в таблицу регистра — их кладёт проведение и снимает оно же;
 *   2. служебный реквизит закрытого документа (`postingState`) — состояние
 *      проведения не учётные данные, и замок неизменности к нему не относится,
 *      но замок об этом знать не может: он видит запись в поле закрытого документа.
 *
 * Оба случая — исключение из правила, а исключение обязано быть НЕПОДДЕЛЫВАЕМЫМ.
 * Признак в контексте (`{ posting: true }`) им не является: контекст собирает любой,
 * кто умеет звать `dbGateway.execute`, и правило превратилось бы в договорённость.
 * Поэтому право — случайный токен, порождённый при старте процесса. Он живёт только
 * в памяти: не уезжает ни в HTTP, ни в клиент, ни в базу, ни в журнал. Подделать его
 * нельзя, а найти все места, где он выдаётся, — один grep по `coreWrite`.
 *
 * Право ВСЕГДА узкое: вместе с токеном едет список полей, которые им разрешено
 * записать (`allow`). «Открыть весь замок» умеет только `ALL`, и он дан ровно одному
 * потребителю — записи движений в регистр, где своя строка создаётся целиком.
 *
 * Использование:
 *     const coreWrite = require('./coreWrite');
 *     await dbGateway.execute({ ..., context: { ...ctx, coreWrite: coreWrite.grant(['postingState']) } });
 *
 * Проверка (в middleware/замке):
 *     if (coreWrite.allows(request, 'postingState')) { ... }
 */

const crypto = require('crypto');

/** Секрет процесса. Наружу не отдаётся никогда — только сравнивается. */
const TOKEN = crypto.randomBytes(24).toString('hex');

/** Разрешение «вся строка целиком». */
const ALL = '*';

/**
 * Выдать право записи.
 * @param {Array<string>|'*'} allow — поля, которые разрешено записать, либо `ALL`
 * @returns {{token: string, allow: Array<string>|'*'}} значение для `context.coreWrite`
 */
function grant(allow) {
    return { token: TOKEN, allow: allow === ALL ? ALL : (Array.isArray(allow) ? allow.slice() : []) };
}

/** Право в запросе подлинное? */
function isGranted(request) {
    const g = request && request.context && request.context.coreWrite;
    return !!(g && g.token === TOKEN);
}

/**
 * Запросу разрешено записать это поле?
 * @param {object} request — запрос `dbGateway`
 * @param {string} field — имя поля; `ALL` — вопрос «разрешена ли запись строки целиком»
 * @returns {boolean}
 */
function allows(request, field) {
    if (!isGranted(request)) return false;
    const allow = request.context.coreWrite.allow;
    if (allow === ALL) return true;
    if (field === ALL) return false;
    return Array.isArray(allow) && allow.indexOf(field) !== -1;
}

/**
 * Поля запроса, НЕ покрытые выданным правом. Пустой массив — право покрывает всё,
 * что запрос собирается записать.
 * @param {object} request
 * @param {Array<string>} fields — поля, о которых идёт спор
 * @returns {Array<string>}
 */
function notAllowed(request, fields) {
    if (!isGranted(request)) return fields || [];
    const allow = request.context.coreWrite.allow;
    if (allow === ALL) return [];
    return (fields || []).filter(f => allow.indexOf(f) === -1);
}

module.exports = { ALL, grant, isGranted, allows, notAllowed };
