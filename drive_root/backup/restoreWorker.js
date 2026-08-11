'use strict';

/**
 * restoreWorker — процесс-исполнитель полного восстановления (ТЗ §6.2 п. 3).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОЦЕСС. Изоляция даёт возможность убить операцию по таймауту, не
 * оставив главный процесс в неопределённом состоянии, и не даёт долгой загрузке
 * занимать его event loop. Главный процесс при этом БАЗУ НЕ ТРОГАЕТ — он только
 * транслирует прогресс в файл состояния, который читает страница обслуживания.
 *
 * ПРИВАТНЫЙ КЛЮЧ ПРИХОДИТ ЧЕРЕЗ IPC И ЖИВЁТ ТОЛЬКО В ПАМЯТИ. Ни в аргументах командной
 * строки (их видно в списке процессов), ни во временном файле, ни в переменной
 * окружения, ни в журнале. Поэтому после аварии восстановление нельзя «продолжить
 * само» — администратор введёт ключ заново, и это правильно.
 */

const path = require('path');

process.env.MOS_RESTORE_WORKER = '1';

if (process.env.PROJECT_ROOT) {
    try {
        require('../globalServerContext').setProjectRoot(process.env.PROJECT_ROOT);
    } catch (e) {
        console.error('[restoreWorker] Не удалось установить PROJECT_ROOT:', e.message);
    }
}

const send = (msg) => { try { if (process.send) process.send(msg); } catch (e) {} };

process.on('message', async (msg) => {
    if (!msg || msg.type !== 'run') return;

    const restoreFull = require('./restoreFull');
    const sequelize = require('../db/sequelize_instance');

    // Ключ достаём из сообщения и НЕМЕДЛЕННО убираем ссылку на объект сообщения:
    // он не должен пережить операцию ни в одной структуре, которую можно случайно
    // сериализовать в журнал.
    const privateKeyPem = String(msg.privateKeyPem || '');
    const passphrase = msg.passphrase ? String(msg.passphrase) : undefined;
    const filePath = String(msg.filePath || '');
    msg.privateKeyPem = null;
    msg.passphrase = null;

    try {
        const result = await restoreFull.runPhases({
            sequelize, filePath, privateKeyPem, passphrase,
            restoreSystemData: (msg && msg.restoreSystemData) || {},
            report: (phase, text, progress) => send({ type: 'progress', phase, text, progress })
        });
        send({ type: 'done', result });
    } catch (e) {
        send({
            type: 'error',
            // `switched`/`shadowSchema` из ошибки не восстановить, но состояние важно:
            // главный процесс по нему решает, можно ли снимать флаг обслуживания.
            switched: !!(e && e.switched),
            rollbackSchema: (e && e.rollbackSchema) || '',
            errorKey: (e && e.errorKey) || '',
            vars: (e && e.vars) || {},
            message: (e && e.message) || String(e),
            stack: (e && e.stack) || ''
        });
    } finally {
        try { await sequelize.close(); } catch (e) {}
        // Небольшая пауза, чтобы сообщение успело уйти до выхода процесса.
        setTimeout(() => process.exit(0), 150);
    }
});

send({ type: 'ready' });
