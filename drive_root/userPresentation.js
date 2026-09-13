'use strict';

/**
 * userPresentation — как показать пользователя человеку.
 *
 * У справочника пользователей ДВА имени, и путать их нельзя:
 *   `name`          — ЛОГИН. По нему идёт вход (`login.server.js`: `where: { name }`),
 *                     он обязателен и уникален по смыслу. Переписать его «Иваном
 *                     Ивановичем» значит сменить логин.
 *   `presentation`  — ПРЕДСТАВЛЕНИЕ. То, что видит человек: в переписке, в списках
 *                     выбора, в подписи записи. Необязательно.
 *
 * Правило одно на всю систему: **представление, иначе логин**. Оно живёт здесь,
 * а не переписывается по месту в каждом приложении, потому что «если есть — иначе»
 * переписанное трижды однажды разойдётся, и один и тот же человек будет называться
 * в системе по-разному.
 *
 * В списках выбора и FK-колонках то же правило применяет ЯДРО: модель объявляет своё
 * поле представления (`entityConfig.presentationField: "presentation"`), а
 * `globalServerContext.presentationFieldOf` / `pickDisplayValue` подставляют логин,
 * когда представление не заполнено. Этот модуль — для кода, который берёт
 * пользователей моделью напрямую (мессенджер, форма настроек).
 *
 * @module drive_root/userPresentation
 */

const log = require('./log');

/**
 * Поля, которые надо выбрать из `users`, чтобы построить представление.
 * Выбирать `['UID', 'name']` и надеяться на представление нельзя — его в выборке
 * просто не окажется, и правило молча выродится в «всегда логин».
 * @type {string[]}
 */
const ATTRIBUTES = ['UID', 'name', 'presentation'];

/** Пусто — это и пробелы тоже: представление из одного пробела показывать нечего. */
function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === '';
}

/**
 * Представление пользователя: `presentation`, иначе `name` (логин), иначе UID.
 *
 * @param {Object} user — запись пользователя (raw или экземпляр модели)
 * @returns {string}
 */
function presentationOf(user) {
    if (!user) return '';
    const plain = (typeof user.get === 'function') ? user.get({ plain: true }) : user;
    if (!isBlank(plain.presentation)) return String(plain.presentation).trim();
    if (!isBlank(plain.name)) return String(plain.name);
    return plain.UID ? String(plain.UID) : '';
}

/**
 * Представления пачкой: один запрос на список идентификаторов.
 *
 * Именно пачкой, а не вызовом на каждого: список чатов показывает собеседников
 * десятками, и запрос на каждого превратил бы открытие окна в N запросов.
 *
 * @param {Object} modelsDB — модели рантайма (нужна `Users`)
 * @param {string[]} userIds
 * @returns {Promise<Map<string, string>>} UID → представление
 */
async function presentationsByIds(modelsDB, userIds) {
    const out = new Map();
    const ids = Array.from(new Set((userIds || []).filter(Boolean).map(String)));
    if (!ids.length || !modelsDB || !modelsDB.Users) return out;
    try {
        const rows = await modelsDB.Users.findAll({ where: { UID: ids }, attributes: ATTRIBUTES, raw: true });
        for (const row of rows) out.set(row.UID, presentationOf(row));
    } catch (e) {
        log.error('[userPresentation] представления не прочитаны:', e && e.message);
    }
    return out;
}

module.exports = { ATTRIBUTES, presentationOf, presentationsByIds };
