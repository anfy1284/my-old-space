'use strict';

/**
 * maintenanceServer — страница обслуживания и аварийный вход (ТЗ §6.2).
 *
 * САМОДОСТАТОЧНОСТЬ — не украшение. Обычный рабочий стол MySpace без базы не
 * соберётся: ему нужны приложения, лейауты, настройки пользователя, сессия. А режим
 * обслуживания включается ровно тогда, когда базы может не быть вовсе. Поэтому здесь
 * отдельная минимальная страница: разметка и стили инлайном, переводы — из `i18n.json`
 * (они грузятся с диска, значит многоязычность не теряется), ни одного обращения к БД.
 *
 * РОУТЫ СУЩЕСТВУЮТ, ТОЛЬКО ПОКА ЛЕЖИТ ФАЙЛ-ФЛАГ. Вне режима обслуживания их нет
 * вообще — не «отдают 403», а не зарегистрированы (приёмка §9 п. 20). Это и есть
 * главное ограничение, делающее аварийный вход безопасным: он физически недоступен,
 * когда система работает нормально.
 *
 * Модуль работает в двух ролях:
 *   1. как обработчик внутри поднятого сервера (гейт в `drive_root/server.js`);
 *   2. как ЕДИНСТВЕННЫЙ обработчик, когда сервер стартовал с флагом и вообще не
 *      инициализировал базу (`main_server.js`).
 */

const http = require('http');
const crypto = require('crypto');

const log = require('./log');
const maintenance = require('./maintenance');
const recovery = require('./recoveryPassword');
const i18n = require('./i18n');

const PREFIX = '/maintenance';

// ── Аварийная сессия ────────────────────────────────────────────────────────────
//
// В памяти процесса и только в ней: таблицы `sessions` может не существовать. Гибнет
// вместе с процессом — это правильно, ключ и права после аварии подтверждаются заново.
const _tokens = new Map();               // token → { created, expires, ip }
const TOKEN_TTL_MS = 60 * 60 * 1000;

// Ограничение частоты попыток: механизм защищает от того, кто дотянулся до HTTP.
const _attempts = new Map();             // ip → { count, first, blockedUntil }
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

function clientIp(req) {
    return String((req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress) || 'unknown');
}

function rateLimited(ip) {
    const rec = _attempts.get(ip);
    if (!rec) return false;
    if (rec.blockedUntil && Date.now() < rec.blockedUntil) return true;
    if (rec.blockedUntil && Date.now() >= rec.blockedUntil) { _attempts.delete(ip); return false; }
    return false;
}

function noteFailure(ip) {
    const now = Date.now();
    const rec = _attempts.get(ip) || { count: 0, first: now };
    if (now - rec.first > ATTEMPT_WINDOW_MS) { rec.count = 0; rec.first = now; }
    rec.count++;
    if (rec.count >= MAX_ATTEMPTS) rec.blockedUntil = now + BLOCK_MS;
    _attempts.set(ip, rec);
}

function issueToken(ip) {
    const token = crypto.randomBytes(32).toString('hex');
    _tokens.set(token, { created: Date.now(), expires: Date.now() + TOKEN_TTL_MS, ip });
    return token;
}

function checkToken(req) {
    const raw = String(req.headers['authorization'] || '');
    const m = raw.match(/^Bearer\s+(\S+)$/i);
    if (!m) return false;
    const rec = _tokens.get(m[1]);
    if (!rec) return false;
    if (Date.now() > rec.expires) { _tokens.delete(m[1]); return false; }
    return true;
}

// ── Утилиты ответа ──────────────────────────────────────────────────────────────

function sendJSON(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); } });
    });
}

/**
 * Язык страницы — из заголовка браузера: сессии и настроек пользователя нет и быть
 * не может. Фолбэк на английский делает сам `i18n.t`.
 */
function pageLang(req) {
    const raw = String(req.headers['accept-language'] || '');
    const code = raw.split(',')[0].split('-')[0].toLowerCase();
    return ['en', 'ru', 'de', 'pl'].includes(code) ? code : 'en';
}

const T = (key, lang) => {
    try { return i18n.t(key, lang); } catch (e) { return key; }
};

// ── Сервисные действия ──────────────────────────────────────────────────────────

/**
 * Подключение к базе для сервисных действий.
 *
 * Создаётся ОТДЕЛЬНОЕ, а не берётся общий экземпляр: в режиме обслуживания сервер мог
 * стартовать вообще без инициализации базы, и общего экземпляра просто нет.
 */
function serviceSequelize() {
    return require('./db/sequelize_instance');
}

async function serviceState() {
    const st = maintenance.read() || {};
    const out = {
        active: maintenance.isActive(),
        reason: st.reason || '',
        phase: st.phase || '',
        startedAt: st.startedAt || '',
        updatedAt: st.updatedAt || '',
        byUser: st.byUser || '',
        sourceFile: st.sourceFile || '',
        mode: st.mode || '',
        switched: !!st.switched,
        shadowSchema: st.shadowSchema || '',
        rollbackSchema: st.rollbackSchema || '',
        error: st.error || null,
        progress: st.progress || null,
        log: Array.isArray(st.log) ? st.log.slice(-100) : [],
        audit: maintenance.tailAudit(30),
        recoveryPasswordSet: recovery.isSet(),
        rollbacks: [],
        dbReachable: false
    };
    try {
        const dialect = require('./backup/dialect');
        const s = serviceSequelize();
        await s.query('SELECT 1');
        out.dbReachable = true;
        out.rollbacks = await dialect.listRollbackSchemas(s);
    } catch (e) {
        out.dbError = e.message;
    }
    return out;
}

const ACTIONS = {

    /** Откат обратным переименованием — мгновенный, без разворачивания safety-выгрузки. */
    async rollback(payload) {
        const dialect = require('./backup/dialect');
        const s = serviceSequelize();
        const list = await dialect.listRollbackSchemas(s);
        const target = payload.schema || list[0];
        if (!target) return { ok: false, errorKey: 'maint_err_no_rollback' };
        if (!list.includes(target)) return { ok: false, errorKey: 'maint_err_no_rollback' };
        const res = await dialect.rollbackToSchema(s, target);
        maintenance.audit(`ROLLBACK schema=${target} failed=${res.failedSchema}`);
        maintenance.update({ phase: 'rolled_back', switched: false, rollbackSchema: '', error: null });
        return { ok: true, failedSchema: res.failedSchema };
    },

    /** Удалить мусорную теневую схему, оставшуюся от оборванной попытки. */
    async dropShadow() {
        const dialect = require('./backup/dialect');
        const s = serviceSequelize();
        await dialect.dropSchema(s, dialect.SHADOW_SCHEMA);
        maintenance.audit('DROP_SHADOW');
        return { ok: true };
    },


    /**
     * Копии, пригодные для восстановления, — читаются С ДИСКА.
     *
     * Журнал `backup_files` живёт в базе, а база в этот момент и есть предмет аварии.
     * Каталог хранения — единственный источник, которому здесь можно верить.
     */
    async listFiles() {
        const runner = require('./backup/restoreFullRunner');
        const st = maintenance.read() || {};
        const files = runner.listRestorableFiles();
        return {
            ok: true,
            sourceFile: st.sourceFile || '',        // файл прерванной попытки — подсветить
            files: files.filter(f => f.scopeType === 'full')
        };
    },

    /**
     * ПОВТОРИТЬ восстановление, не снимая блокировку (ТЗ §6.2, «выход из тупика»).
     *
     * Тем же действием разворачивается и safety-выгрузка: это тот же файл в том же
     * каталоге, отличается только выбор в списке. Двух отдельных кнопок для одной
     * операции заводить незачем.
     *
     * Ответ отдаётся СРАЗУ: восстановление идёт минутами, а ход операции виден в том же
     * состоянии, которое страница и так опрашивает.
     */
    async restoreFromFile(payload) {
        if (_restoreRunning) return { ok: false, errorKey: 'maint_err_restore_running' };

        const runner = require('./backup/restoreFullRunner');
        const settingsStore = require('./backup/settings');
        const path = require('path');

        const fileName = String(payload.fileName || '');
        // Имя берём ТОЛЬКО из собственного списка: путь с клиента не принимается, иначе
        // страница превращается в чтение произвольного файла с диска сервера.
        const known = runner.listRestorableFiles().some(f => f.fileName === fileName);
        if (!known) {
            maintenance.audit(`RESTORE_RETRY_REFUSED file=${fileName} reason=unknown_file`);
            return { ok: false, errorKey: 'maint_err_unknown_file' };
        }

        const filePath = path.join(settingsStore.storagePath(), fileName);
        const opts = {
            filePath,
            privateKeyPem: String(payload.privateKeyPem || ''),
            userId: 'recovery-admin'
        };

        // Быстрые проверки — ДО ответа. Про негодный ключ надо сказать прямо, а не отдать
        // «запущено» и оставить администратора выяснять по фазе, почему ничего не вышло.
        const pre = await runner.precheckRetry(opts);
        if (!pre.ok) {
            // Отказ тоже в аудит: неудачные попытки подобрать ключ — ровно то, что потом
            // разбирают, а страница живёт за аварийным паролем и следов больше нигде нет.
            maintenance.audit(`RESTORE_RETRY_REFUSED file=${fileName} reason=${pre.errorKey}`);
            return pre;
        }

        _restoreRunning = true;

        // Дальше не ждём: HTTP-ответ нужен сейчас, а сама операция идёт минутами.
        Promise.resolve()
            .then(() => runner.retry(opts))
            .then((res) => {
                _restoreRunning = false;
                if (!res.ok) {
                    log.error(`[maintenance] Повтор восстановления не удался: ${res.errorKey || res.message}`);
                    return;
                }
                // Успех: блокировка уже снята внутри retry. Если мы автономный сервер —
                // передаём управление обычному старту, иначе процесс так и останется
                // отвечать 503, не имея загруженных приложений.
                if (_standalone && typeof _standalone.onResume === 'function') {
                    setTimeout(() => {
                        Promise.resolve(_standalone.onResume(_standalone.server))
                            .catch(e => log.error(`[maintenance] Передача управления: ${e.message}`));
                    }, 500);
                }
            })
            .catch((e) => {
                _restoreRunning = false;
                log.error(`[maintenance] Повтор восстановления: ${e.stack || e.message}`);
                try { maintenance.update({ phase: 'failed', error: e.message }, true); } catch (e2) {}
            });

        return { ok: true, started: true };
    },

    /**
     * Снять блокировку вручную.
     *
     * Отдельное осознанное действие администратора — именно поэтому флаг и не
     * снимается сам при перезапуске. Пишется в аудит-лог.
     *
     * Если мы работаем автономно (сервер стартовал с флагом и базу не инициализировал),
     * после снятия блокировки управление передаётся ОБЫЧНОМУ старту. Иначе получился бы
     * тупик: блокировки нет, а процесс продолжает отвечать 503, потому что приложений у
     * него не загружено. Требовать здесь перезапуск — значит вернуть себе супервизор.
     */
    async unlock(payload) {
        maintenance.clear({ who: 'recovery-admin', note: String(payload.note || 'manual') });
        if (_standalone && typeof _standalone.onResume === 'function') {
            // Отвечаем СНАЧАЛА, передаём управление потом: закрытие слушателя оборвало
            // бы этот же ответ, и администратор не узнал бы, чем кончилось.
            setTimeout(() => {
                Promise.resolve(_standalone.onResume(_standalone.server))
                    .catch(e => log.error(`[maintenance] Передача управления не удалась: ${e.message}`));
            }, 300);
            return { ok: true, resuming: true };
        }
        return { ok: true };
    }
};

// Ссылка на автономный режим: заполняется только при `startStandalone`.
let _standalone = null;

// Идёт ли повтор восстановления. Двух одновременных быть не должно: они полезут в одну
// теневую схему и затрут работу друг друга.
let _restoreRunning = false;

// ── Обработчик запросов ─────────────────────────────────────────────────────────

/**
 * @returns {Promise<boolean>} `true` — запрос обработан здесь
 */
async function handle(req, res) {
    // Вне режима обслуживания роутов не существует вовсе. Проверка стоит ПЕРВОЙ
    // строкой, до разбора пути: иначе «маршрут есть, но отвечает 403» — а это уже
    // поверхность атаки, которой по ТЗ быть не должно.
    if (!maintenance.isActive()) return false;

    // Ответчик, который переводит `errorKey` в текст. Один на все ответы: язык здесь
    // выведен из заголовка браузера (сессии в аварии нет), а показывать администратору
    // голый ключ вида `maint_err_bad_password` — значит не сказать ничего.
    const lang = pageLang(req);
    const reply = (status, obj) => {
        if (obj && obj.ok === false && obj.errorKey && !obj.error) {
            obj.error = i18n.tf(obj.errorKey, lang, obj.vars || {});
        }
        return sendJSON(res, status, obj);
    };

    const url = String(req.url || '').split('?')[0];
    if (url !== '/' && url !== PREFIX && !url.startsWith(PREFIX + '/')) {
        // Всё остальное в режиме обслуживания получает 503 — но это забота гейта,
        // а не наша: здесь мы отвечаем только за свои адреса.
        return false;
    }

    // Страница
    if (req.method === 'GET' && (url === '/' || url === PREFIX || url === PREFIX + '/')) {
        const html = renderPage(pageLang(req));
        res.writeHead(503, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Retry-After': '120'
        });
        res.end(html);
        return true;
    }

    // Состояние — без авторизации: это та самая страница, ради которой всё затевалось,
    // и она не должна требовать пароля, чтобы сказать «идёт восстановление, фаза такая».
    // Ничего чувствительного в ответе нет.
    if (req.method === 'GET' && url === PREFIX + '/api/state') {
        try {
            return sendJSON(res, 200, await serviceState()), true;
        } catch (e) {
            return sendJSON(res, 500, { error: e.message }), true;
        }
    }

    // Аварийный вход
    if (req.method === 'POST' && url === PREFIX + '/api/login') {
        const ip = clientIp(req);
        const body = await readBody(req);
        if (rateLimited(ip)) {
            maintenance.audit(`RECOVERY_LOGIN_BLOCKED ip=${ip}`);
            return reply(429, { ok: false, errorKey: 'maint_err_rate_limited' }), true;
        }
        if (!recovery.isSet()) {
            maintenance.audit(`RECOVERY_LOGIN_NO_PASSWORD ip=${ip}`);
            return reply(403, { ok: false, errorKey: 'maint_err_no_password' }), true;
        }
        const ok = await recovery.verify(body.password);
        maintenance.audit(`RECOVERY_LOGIN ${ok ? 'OK' : 'FAIL'} ip=${ip}`);
        if (!ok) {
            noteFailure(ip);
            // Единообразный отказ: не различаем «пароль не задан» и «пароль неверен»
            // по времени и тексту сильнее, чем уже сделано выше.
            return reply(401, { ok: false, errorKey: 'maint_err_bad_password' }), true;
        }
        _attempts.delete(ip);
        return sendJSON(res, 200, { ok: true, token: issueToken(ip) }), true;
    }

    // Сервисные действия — только по аварийному токену
    const actionMatch = url.match(new RegExp('^' + PREFIX + '/api/action/([a-zA-Z]+)$'));
    if (req.method === 'POST' && actionMatch) {
        if (!checkToken(req)) return reply(401, { ok: false, errorKey: 'maint_err_unauthorized' }), true;
        const fn = ACTIONS[actionMatch[1]];
        if (!fn) return reply(404, { ok: false, errorKey: 'maint_err_unknown_action' }), true;
        try {
            const body = await readBody(req);
            return reply(200, await fn(body)), true;
        } catch (e) {
            log.error(`[maintenance] Действие ${actionMatch[1]}: ${e.stack || e.message}`);
            maintenance.audit(`ACTION_FAILED ${actionMatch[1]} error=${e.message}`);
            return sendJSON(res, 500, { ok: false, error: e.message }), true;
        }
    }

    return sendJSON(res, 404, { error: 'not found' }), true;
}

/** Ответ 503 всему остальному, пока идёт обслуживание. */
function sendUnavailable(req, res) {
    const accepts = String(req.headers.accept || '');
    if (accepts.includes('text/html')) {
        res.writeHead(302, { Location: PREFIX, 'Cache-Control': 'no-store' });
        res.end();
        return;
    }
    const body = JSON.stringify({ error: 'maintenance', maintenance: true, url: PREFIX });
    res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'Retry-After': '120'
    });
    res.end(body);
}

// ── Разметка ────────────────────────────────────────────────────────────────────

function renderPage(lang) {
    const t = (k) => String(T(k, lang)).replace(/</g, '&lt;');
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('maint_page_title')}</title>
<style>
  body { background:#008080; font-family: "MS Sans Serif", Tahoma, sans-serif; font-size:12px; margin:0; padding:24px; color:#000; }
  .win { max-width: 860px; margin: 0 auto 16px; background:#c0c0c0; border:2px outset #fff; padding:2px; }
  .title { background:#000080; color:#fff; padding:3px 6px; font-weight:bold; }
  .body { padding:12px; }
  h2 { font-size:13px; margin:14px 0 6px; }
  table { border-collapse:collapse; width:100%; }
  td { padding:2px 6px; vertical-align:top; }
  td.k { color:#000080; width:210px; }
  pre { background:#fff; border:1px inset #fff; padding:6px; max-height:240px; overflow:auto; margin:0; font-family:Consolas,monospace; font-size:11px; white-space:pre-wrap; }
  button { font-family:inherit; font-size:12px; padding:3px 12px; background:#c0c0c0; border:2px outset #fff; cursor:pointer; margin:2px 4px 2px 0; }
  button:active:not(:disabled) { border-style:inset; }
  button:disabled { color:#808080; cursor:default; }
  input[type=password] { font-family:inherit; font-size:12px; border:2px inset #fff; padding:2px 4px; width:220px; }
  .warn { background:#ffffe1; border:1px solid #808080; padding:8px; margin:8px 0; }
  .err { color:#800000; font-weight:bold; }
  .ok { color:#006000; font-weight:bold; }
  .bar { border:1px inset #fff; background:#fff; height:16px; padding:1px; }
  .bar > i { display:block; height:100%; background:#000080; width:0; }
  #file-list { margin-top:6px; }
  #file-list td { border-bottom:1px solid #d0d0d0; padding:2px 6px; }
  #file-list tr { cursor:pointer; }
  #file-list tr.sel { background:#000080; color:#fff; }
  .tag { font-size:10px; border:1px solid #808080; padding:0 3px; margin-left:4px; }
</style>
</head>
<body>

<div class="win">
  <div class="title">${t('maint_page_title')}</div>
  <div class="body">
    <div class="warn">${t('maint_intro')}</div>
    <table>
      <tr><td class="k">${t('maint_state_reason')}</td><td id="s-reason">…</td></tr>
      <tr><td class="k">${t('maint_state_phase')}</td><td id="s-phase">…</td></tr>
      <tr><td class="k">${t('maint_state_started')}</td><td id="s-started">…</td></tr>
      <tr><td class="k">${t('maint_state_source')}</td><td id="s-source">…</td></tr>
      <tr><td class="k">${t('maint_state_mode')}</td><td id="s-mode">…</td></tr>
      <tr><td class="k">${t('maint_state_db')}</td><td id="s-db">…</td></tr>
      <tr><td class="k">${t('maint_state_error')}</td><td id="s-error" class="err"></td></tr>
    </table>
    <div class="bar" style="margin-top:8px"><i id="s-bar"></i></div>
    <h2>${t('maint_log')}</h2>
    <pre id="s-log"></pre>
  </div>
</div>

<div class="win">
  <div class="title">${t('maint_login_title')}</div>
  <div class="body">
    <div id="login-box">
      <p>${t('maint_login_hint')}</p>
      <input type="password" id="pwd" autocomplete="off">
      <button id="btn-login">${t('maint_login_btn')}</button>
      <span id="login-msg"></span>
    </div>
    <div id="actions-box" style="display:none">
      <p class="ok">${t('maint_login_ok')}</p>
      <h2>${t('maint_retry_title')}</h2>
      <div class="warn">${t('maint_retry_hint')}</div>
      <table id="file-list"><tbody></tbody></table>
      <div style="margin-top:8px">
        <button id="btn-pick-key">${t('maint_retry_key_btn')}</button>
        <span id="key-state"></span>
      </div>
      <button id="btn-restore" style="margin-top:8px">${t('maint_retry_run_btn')}</button>

      <h2>${t('maint_other_actions')}</h2>
      <button id="btn-rollback">${t('maint_action_rollback')}</button>
      <button id="btn-drop-shadow">${t('maint_action_drop_shadow')}</button>
      <button id="btn-unlock">${t('maint_action_unlock')}</button>
      <div id="action-msg" style="margin-top:8px"></div>
      <div class="warn" style="margin-top:8px">${t('maint_action_hint')}</div>
    </div>
  </div>
</div>

<div class="win">
  <div class="title">${t('maint_audit')}</div>
  <div class="body"><pre id="s-audit"></pre></div>
</div>

<script>
(function () {
  var token = null;
  var E = function (id) { return document.getElementById(id); };
  var txt = function (id, v) { E(id).textContent = v == null ? '' : String(v); };

  function refresh() {
    fetch('${PREFIX}/api/state', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s.active) { location.reload(); return; }
        txt('s-reason', s.reason);
        txt('s-phase', s.phase);
        txt('s-started', s.startedAt);
        txt('s-source', s.sourceFile);
        txt('s-mode', s.mode + (s.switched ? ' / switched' : ''));
        txt('s-db', s.dbReachable ? 'ok' : ('unavailable: ' + (s.dbError || '')));
        txt('s-error', s.error || '');
        txt('s-log', (s.log || []).join('\\n'));
        txt('s-audit', (s.audit || []).join('\\n'));
        var pct = (s.progress && s.progress.total) ? Math.round(100 * s.progress.done / s.progress.total) : 0;
        E('s-bar').style.width = pct + '%';
        E('btn-rollback').disabled = !(s.rollbacks && s.rollbacks.length);
      })
      .catch(function () {});
  }

  E('btn-login').addEventListener('click', function () {
    E('login-msg').textContent = '';
    fetch('${PREFIX}/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: E('pwd').value })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.ok) { token = j.token; E('login-box').style.display = 'none'; E('actions-box').style.display = ''; refresh(); loadFiles(); }
      else { E('login-msg').textContent = ' ' + (j.errorKey || 'error'); E('login-msg').className = 'err'; }
      E('pwd').value = '';
    }).catch(function (e) { E('login-msg').textContent = String(e); });
  });

  E('pwd').addEventListener('keydown', function (e) { if (e.key === 'Enter') E('btn-login').click(); });

  function action(name, confirmKey) {
    if (!confirm(confirmKey)) return;
    E('action-msg').textContent = '…';
    fetch('${PREFIX}/api/action/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({})
    }).then(function (r) { return r.json(); }).then(function (j) {
      E('action-msg').textContent = j.ok ? 'OK' : ('ERROR: ' + (j.error || j.errorKey));
      E('action-msg').className = j.ok ? 'ok' : 'err';
      if (name === 'unlock' && j.ok) setTimeout(function () { location.href = '/'; }, 1200);
      refresh();
    }).catch(function (e) { E('action-msg').textContent = String(e); });
  }

  // ── Повтор восстановления, НЕ снимая блокировку ────────────────────────────
  //
  // Тем же действием разворачивается safety-выгрузка: это тот же каталог, отличается
  // только выбор строки в списке. Список читается С ДИСКА — журнал копий живёт в базе,
  // а база в этот момент и есть предмет аварии.
  var _files = [], _pick = null, _key = '', _sourceFile = '';

  function renderFiles() {
    var tb = E('file-list').querySelector('tbody');
    tb.innerHTML = '';
    if (!_files.length) {
      tb.innerHTML = '<tr><td>' + ${JSON.stringify(String(T('maint_retry_no_files', lang)))} + '</td></tr>';
      E('btn-restore').disabled = true;
      return;
    }
    if (_pick === null) {
      // По умолчанию — файл прерванной попытки, иначе самый свежий.
      var i = -1;
      for (var k = 0; k < _files.length; k++) if (_files[k].fileName === _sourceFile) { i = k; break; }
      _pick = i >= 0 ? i : 0;
    }
    _files.forEach(function (f, i) {
      var tr = document.createElement('tr');
      if (i === _pick) tr.className = 'sel';
      var tags = '';
      if (!f.encrypted) tags += '<span class="tag">PLAIN</span>';
      if (f.fileName === _sourceFile) tags += '<span class="tag">' + ${JSON.stringify(String(T('maint_retry_same_file', lang)))} + '</span>';
      tr.innerHTML = '<td>' + String(f.createdAt).slice(0, 19).replace('T', ' ') + '</td>'
        + '<td>' + f.fileName + tags + '</td>'
        + '<td style="text-align:right">' + Math.round((f.size || 0) / 1024) + ' KB</td>';
      tr.addEventListener('click', function () { _pick = i; renderFiles(); });
      tb.appendChild(tr);
    });
    E('btn-restore').disabled = false;
    // Ключ нужен только зашифрованной копии.
    E('btn-pick-key').disabled = !_files[_pick].encrypted;
  }

  function loadFiles() {
    if (!token) return;
    fetch('${PREFIX}/api/action/listFiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({})
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) return;
      _files = j.files || [];
      _sourceFile = j.sourceFile || '';
      renderFiles();
    }).catch(function () {});
  }

  E('btn-pick-key').addEventListener('click', function () {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pem,.key';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { _key = String(rd.result || ''); E('key-state').textContent = ' ' + f.name; };
      rd.readAsText(f);
    });
    input.click();
  });

  E('btn-restore').addEventListener('click', function () {
    var f = _files[_pick];
    if (!f) return;
    if (f.encrypted && !_key) {
      E('action-msg').textContent = ${JSON.stringify(String(T('maint_retry_need_key', lang)))};
      E('action-msg').className = 'err';
      return;
    }
    if (!confirm(${JSON.stringify(String(T('maint_confirm_retry', lang)))} + '\\n\\n' + f.fileName)) return;
    E('action-msg').textContent = '…';
    fetch('${PREFIX}/api/action/restoreFromFile', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ fileName: f.fileName, privateKeyPem: _key })
    }).then(function (r) { return r.json(); }).then(function (j) {
      E('action-msg').textContent = j.ok ? '' : ('ERROR: ' + (j.error || j.errorKey));
      E('action-msg').className = j.ok ? 'ok' : 'err';
      // Ключ в странице не держим: он был нужен на одну операцию.
      _key = ''; E('key-state').textContent = '';
      refresh();
    }).catch(function (e) { E('action-msg').textContent = String(e); });
  });

  E('btn-rollback').addEventListener('click', function () { action('rollback', ${JSON.stringify(String(T('maint_confirm_rollback', lang)))}); });
  E('btn-drop-shadow').addEventListener('click', function () { action('dropShadow', ${JSON.stringify(String(T('maint_confirm_drop_shadow', lang)))}); });
  E('btn-unlock').addEventListener('click', function () { action('unlock', ${JSON.stringify(String(T('maint_confirm_unlock', lang)))}); });

  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>`;
}

/**
 * Поднять САМОСТОЯТЕЛЬНЫЙ сервер обслуживания.
 *
 * Используется, когда флаг обнаружен при старте: тогда фаза инициализации базы
 * пропускается ЦЕЛИКОМ, обычные приложения не грузятся вовсе (их `init.js` ходит в
 * базу), а порт занимает только эта страница. Пользователи в систему не допускаются
 * ни при каком раскладе.
 */
function startStandalone(port, opts = {}) {
    // Реестр переводов грузится С ДИСКА и базы не требует — в обычном старте это
    // делает `drive_forms/init.js`, но его мы здесь не выполняем (он тянет приложения,
    // а те ходят в БД). Без этой строки страница обслуживания показывала бы КЛЮЧИ
    // вместо текста ровно в тот момент, когда человеку нужно понять, что произошло.
    try {
        require('./i18n').loadI18n(process.env.PROJECT_ROOT || process.cwd());
    } catch (e) {
        log.warn(`[maintenance] Переводы не загружены: ${e.message}`);
    }

    const server = http.createServer((req, res) => {
        handle(req, res)
            .then(handled => { if (!handled) sendUnavailable(req, res); })
            .catch(e => {
                log.error(`[maintenance] Ошибка обработки: ${e.stack || e.message}`);
                try { sendUnavailable(req, res); } catch (e2) {}
            });
    });
    _standalone = { server, onResume: opts.onResume || null };
    server.listen(port, () => {
        log.warn(`[maintenance] Сервер поднят В РЕЖИМЕ ОБСЛУЖИВАНИЯ на порту ${port}; база не инициализирована`);
    });
    return server;
}

module.exports = { handle, sendUnavailable, startStandalone, renderPage, PREFIX };
