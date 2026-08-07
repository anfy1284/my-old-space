#!/usr/bin/env node
'use strict';

/**
 * Консольная установка аварийного пароля восстановления (ТЗ §6.2а, путь 3).
 *
 * Запуск из корня проекта:
 *   node node_modules/my-old-space/scripts/set-recovery-password.js
 *   node node_modules/my-old-space/scripts/set-recovery-password.js --generate
 *
 * Скрипт ОБЯЗАТЕЛЕН, а не удобство: пароль требуется ровно тогда, когда войти в
 * систему нельзя, и совет «откройте форму настроек» в этот момент не работает. Он же —
 * единственный способ сброса забытого пароля: восстановить хэш нельзя, можно заменить.
 *
 * Пароль не выводится в журнал и не сохраняется нигде, кроме хэша в `dbSettings.json`.
 */

const path = require('path');
const readline = require('readline');

if (!process.env.PROJECT_ROOT) process.env.PROJECT_ROOT = process.cwd();
const recovery = require(path.join(__dirname, '..', 'drive_root', 'recoveryPassword'));

/** Ввод без эха: пароль не должен остаться в буфере терминала и на скриншоте. */
function askHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const onData = (char) => {
            const s = String(char);
            if (s === '\n' || s === '\r' || s === '') {
                process.stdin.removeListener('data', onData);
            } else {
                // Перерисовываем строку без введённых символов.
                readline.clearLine(process.stdout, 0);
                readline.cursorTo(process.stdout, 0);
                process.stdout.write(question);
            }
        };
        process.stdout.write(question);
        process.stdin.on('data', onData);
        rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    });
}

(async () => {
    console.log(`Файл настроек: ${recovery.filePath()}`);
    console.log(recovery.isSet()
        ? 'Аварийный пароль сейчас ЗАДАН. Показать его невозможно (хранится хэшем) — можно только заменить.'
        : 'Аварийный пароль сейчас НЕ ЗАДАН.');

    if (process.argv.includes('--generate')) {
        const plain = await recovery.generate();
        console.log('\nНОВЫЙ АВАРИЙНЫЙ ПАРОЛЬ (показывается ОДИН раз, запишите его):\n');
        console.log('    ' + plain + '\n');
        console.log('Хэш записан в dbSettings.json. Повторно узнать пароль невозможно.');
        process.exit(0);
    }

    const p1 = await askHidden('Новый аварийный пароль (минимум 8 символов): ');
    const p2 = await askHidden('Повторите пароль: ');
    if (p1 !== p2) {
        console.error('Пароли не совпадают — ничего не изменено.');
        process.exit(1);
    }
    try {
        await recovery.set(p1);
        console.log('Аварийный пароль сохранён (хэшем) в dbSettings.json.');
        process.exit(0);
    } catch (e) {
        console.error('Ошибка:', e.message);
        process.exit(1);
    }
})().catch(e => { console.error('Ошибка:', e.stack || e.message); process.exit(1); });
