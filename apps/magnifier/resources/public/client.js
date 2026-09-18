(function () {
    'use strict';

    /**
     * ЭКРАННАЯ ЛУПА.
     *
     * Приложение без окна: точка входа — удержание ЛЕВОГО Alt. Пока клавиша
     * нажата, участок экрана под указателем показывается крупнее; указатель
     * всегда в центре лупы, а сам курсор не увеличивается — его рисует система
     * поверх страницы, и в копию интерфейса он не попадает.
     *
     * ── Откуда берётся увеличенное изображение ───────────────────────────
     * Снимка экрана браузером мы не делаем (`getDisplayMedia` спрашивает
     * разрешение каждый сеанс), а «увеличить настоящую страницу» нельзя: она
     * одна, и увеличилась бы целиком. Поэтому лупа показывает ВТОРУЮ копию того
     * же дерева узлов — живое зеркало ядра (`MySpace.snapshot.mirror`),
     * уменьшенное/увеличенное преобразованием. Копия лежит в теневом дереве,
     * поэтому её `id` не мешают настоящей форме, и обновляется по изменениям, а
     * не по кадрам: пока на экране ничего не происходит, лупа не стоит ничего.
     *
     * ── Что перехватывается, а что нет ───────────────────────────────────
     * Пока лупа на экране, колесо мыши меняет увеличение (с Ctrl — размер самой
     * лупы), поэтому событие колеса гасится. Всё остальное работает как обычно:
     * оверлей не принимает событий мыши (`pointer-events: none`), щелчки и
     * клавиши уходят в приложение под лупой.
     *
     * Правый Alt НЕ используется: на немецкой и польской раскладках это AltGr,
     * которым набирают @, €, ł, — лупа отняла бы ввод.
     *
     * ── Что хранится и где ───────────────────────────────────────────────
     * Включена/выключена и «эффект стекла» — НАСТРОЙКИ уровня `user`
     * (`settings.json`, правит сам человек в форме настроек); выключатель
     * приложения объявлен в манифесте (`enabledBySetting`), поэтому выключенная
     * лупа не слушает клавиатуру вовсе. Увеличение и размер лупы — СОСТОЯНИЕ
     * интерфейса (`MySpace.state`): их меняют колесом десятки раз на дню, и это
     * ровно то, что интерфейс помнит между сеансами.
     */

    const APP = 'magnifier';

    const ZOOM_MIN = 1.2;
    const ZOOM_MAX = 10;
    const ZOOM_STEP = 1.12;
    const ZOOM_DEFAULT = 2;

    /** Размер лупы — доля ширины экрана; высота считается по пропорциям экрана. */
    const SIZE_MIN = 0.15;
    const SIZE_MAX = 0.95;
    const SIZE_STEP = 1.08;
    const SIZE_DEFAULT = 0.4;

    /**
     * Стекло. Копия рисуется с запасом за краями рамки (`GLASS_MARGIN`), иначе
     * искажению нечего подтягивать снаружи и края получились бы прозрачными.
     * Запас обязан быть больше сдвига (`GLASS_EDGE_SHIFT`).
     */
    const GLASS_MARGIN = 0.18;        // доля размера лупы, добавляемая с каждой стороны
    const GLASS_EDGE_SHIFT = 0.12;    // максимальный сдвиг у самого края — доля ширины лупы
    const GLASS_EDGE_START = 0.78;    // до этой доли полуразмера искажения НЕТ ВОВСЕ
    const GLASS_POWER = 2;            // как круто оно нарастает в оставшейся кромке
    const GLASS_MAP_SIZE = 128;       // сторона карты смещений (растягивается на всю лупу)
    const GLASS_RADIUS = 0.06;        // скругление углов — доля меньшей стороны

    const FILTER_ID = 'ms-magnifier-glass';
    const LABEL_HIDE_MS = 900;

    function clamp(value, min, max) {
        return value < min ? min : (value > max ? max : value);
    }

    function numberOr(value, fallback) {
        const n = Number(value);
        return isFinite(n) && n > 0 ? n : fallback;
    }

    /**
     * Профиль искажения вдоль одной оси: 0 — сдвига нет, ±1 — максимальный.
     *
     * `n` — расстояние от центра, где 1 это край лупы. До `GLASS_EDGE_START`
     * возвращается РОВНО ноль: середина лупы — честное увеличение без единого
     * пикселя искажения, стекло видно только кромкой (как в лупе телефона).
     * Плавное нарастание степенью, а не скачком, — иначе на границе плоской
     * части был бы виден шов.
     */
    function glassProfile(n) {
        const distance = Math.abs(n);
        if (distance <= GLASS_EDGE_START) return 0;
        const t = Math.min((distance - GLASS_EDGE_START) / (1 - GLASS_EDGE_START), 1);
        return Math.sign(n) * Math.pow(t, GLASS_POWER);
    }

    const Magnifier = {
        enabled: false,        // приложение включено этому человеку
        active: false,         // лупа сейчас на экране
        listening: false,
        glass: true,
        zoom: ZOOM_DEFAULT,
        size: SIZE_DEFAULT,

        mouseX: 0,
        mouseY: 0,
        lensW: 0,
        lensH: 0,
        marginX: 0,
        marginY: 0,
        mapAspect: 0,          // пропорции экрана, под которые собрана карта смещений

        frame: null,
        lensLayer: null,
        stage: null,
        glare: null,
        label: null,
        mirror: null,
        displaceEl: null,
        mapEl: null,

        _bound: null,
        _labelTimer: 0,
        _frameRequest: 0,
        _inited: false,

        /**
         * Подписка на готовность личных снимков (доступность приложения,
         * настройки, состояние интерфейса) — все три приезжают отдельными
         * запросами при загрузке страницы.
         */
        init: function () {
            if (this._inited) return;
            this._inited = true;

            this._bound = {
                keyDown: this.onKeyDown.bind(this),
                keyUp: this.onKeyUp.bind(this),
                mouseMove: this.onMouseMove.bind(this),
                wheel: this.onWheel.bind(this),
                leave: this.onLeave.bind(this),
                resize: this.onResize.bind(this),
                settingsChanged: this.applySettings.bind(this)
            };
            this.mouseX = Math.round(window.innerWidth / 2);
            this.mouseY = Math.round(window.innerHeight / 2);

            const ms = window.MySpace || {};
            const waits = [
                ms.appAvailability && ms.appAvailability.ready,
                ms.settings && ms.settings.ready,
                ms.state && ms.state.ready
            ].filter(Boolean);

            Promise.all(waits.map(p => Promise.resolve(p).catch(() => null)))
                .then(() => this.applySettings());

            // Настройки правятся в своей форме — там же перечитываются снимки.
            window.addEventListener('app-settings-changed', this._bound.settingsChanged);
        },

        /** Прочитать выключатель, эффект стекла и запомненные увеличение с размером. */
        applySettings: function () {
            const ms = window.MySpace || {};
            this.enabled = !(ms.appAvailability && !ms.appAvailability.isEnabled(APP));
            this.glass = ms.settings ? ms.settings.get(APP, 'glassEffect', true) !== false : true;
            if (ms.state) {
                this.zoom = clamp(numberOr(ms.state.get(APP, 'zoom', ZOOM_DEFAULT), ZOOM_DEFAULT), ZOOM_MIN, ZOOM_MAX);
                this.size = clamp(numberOr(ms.state.get(APP, 'size', SIZE_DEFAULT), SIZE_DEFAULT), SIZE_MIN, SIZE_MAX);
            }

            if (this.enabled) {
                this.listen();
            } else {
                this.hide();
                this.unlisten();
            }
            if (this.active) this.applyAppearance();
        },

        // ── Подписки ─────────────────────────────────────────────────────

        listen: function () {
            if (this.listening) return;
            this.listening = true;
            // Перехват в фазе погружения: лупа должна получить клавишу раньше
            // формы, которая тоже слушает клавиатуру (календарь, выпадающий список).
            window.addEventListener('keydown', this._bound.keyDown, true);
            window.addEventListener('keyup', this._bound.keyUp, true);
            window.addEventListener('mousemove', this._bound.mouseMove, true);
            window.addEventListener('blur', this._bound.leave);
            document.addEventListener('visibilitychange', this._bound.leave);
        },

        unlisten: function () {
            if (!this.listening) return;
            this.listening = false;
            window.removeEventListener('keydown', this._bound.keyDown, true);
            window.removeEventListener('keyup', this._bound.keyUp, true);
            window.removeEventListener('mousemove', this._bound.mouseMove, true);
            window.removeEventListener('blur', this._bound.leave);
            document.removeEventListener('visibilitychange', this._bound.leave);
        },

        // ── События ──────────────────────────────────────────────────────

        onKeyDown: function (e) {
            if (!this.enabled) return;
            // Alt отпустили мимо нас (Alt+Tab уводит фокус, и keyup не приходит).
            if (this.active && !e.altKey) this.hide();
            if (e.key !== 'Alt') return;
            // AltGr приезжает как правый Alt (и обычно с ctrlKey): на немецкой и
            // польской раскладках им набирают символы — отдаём его раскладке.
            if (e.ctrlKey || e.location === 2) return;
            // Гасим собственное действие браузера по Alt (переход в строку меню).
            e.preventDefault();
            if (e.repeat || this.active) return;
            this.show();
        },

        onKeyUp: function (e) {
            if (e.key === 'Alt') this.hide();
        },

        onMouseMove: function (e) {
            this.mouseX = e.clientX;
            this.mouseY = e.clientY;
            if (this.active) this.schedulePlace();
        },

        /** Окно потеряло фокус или вкладка ушла в фон — клавиши мы больше не увидим. */
        onLeave: function () {
            this.hide();
        },

        onResize: function () {
            if (!this.active) return;
            this.applyAppearance();
            this.place();
        },

        /**
         * Колесо: увеличение, с Ctrl — размер самой лупы.
         *
         * Гасится и умолчание браузера (прокрутка страницы, а с Ctrl —
         * масштабирование всей страницы), поэтому слушатель непассивный.
         */
        onWheel: function (e) {
            if (!this.active) return;
            e.preventDefault();
            e.stopPropagation();
            const up = e.deltaY < 0;
            const state = window.MySpace && MySpace.state;

            if (e.ctrlKey) {
                this.size = clamp(this.size * (up ? SIZE_STEP : 1 / SIZE_STEP), SIZE_MIN, SIZE_MAX);
                if (state) state.set(APP, 'size', this.size);
                this.applyAppearance();
                this.showLabel(Math.round(this.size * 100) + '%');
            } else {
                this.zoom = clamp(this.zoom * (up ? ZOOM_STEP : 1 / ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
                if (state) state.set(APP, 'zoom', this.zoom);
                this.showLabel('×' + (Math.round(this.zoom * 10) / 10));
            }
            this.place();
        },

        // ── Показ и скрытие ──────────────────────────────────────────────

        show: function () {
            if (this.active) return;
            this.build();
            this.active = true;
            this.applyAppearance();
            this.place();
            // Сначала свежая копия, потом показ: иначе первый кадр успел бы
            // мигнуть тем, что осталось от прошлого нажатия.
            this.mirror.start();
            this.frame.classList.add('ui-magnifier-visible');
            window.addEventListener('wheel', this._bound.wheel, { capture: true, passive: false });
            window.addEventListener('resize', this._bound.resize);
        },

        hide: function () {
            if (!this.active) return;
            this.active = false;
            window.removeEventListener('wheel', this._bound.wheel, { capture: true });
            window.removeEventListener('resize', this._bound.resize);
            // Копию отпускаем, а не оставляем висеть до следующего нажатия: держать
            // в памяти второе дерево незачем — следующий показ всё равно собирает
            // его заново. Зеркало после этого рабочее, его снова заводит start().
            if (this.mirror) this.mirror.destroy();
            if (this.frame) this.frame.classList.remove('ui-magnifier-visible');
            if (this._frameRequest) { cancelAnimationFrame(this._frameRequest); this._frameRequest = 0; }
            this.hideLabel();
        },

        // ── Разметка ─────────────────────────────────────────────────────

        /**
         * Оверлей лупы. Три слоя, и порядок важен:
         *   frame     — рамка: она обрезает всё лишнее и скругляет углы;
         *   lensLayer — слой искажения: он ШИРЕ рамки на запас `GLASS_MARGIN`,
         *               потому что искажению нужно, что подтянуть из-за края;
         *   stage     — сама копия интерфейса, к ней применяется преобразование.
         * Подпись и блик лежат ПОВЕРХ и в увеличение не попадают.
         */
        build: function () {
            if (this.frame) return;

            const frame = document.createElement('div');
            frame.className = 'ui-magnifier';

            const lensLayer = document.createElement('div');
            lensLayer.className = 'ui-magnifier-lens';

            const stage = document.createElement('div');
            stage.className = 'ui-magnifier-stage';
            lensLayer.appendChild(stage);
            frame.appendChild(lensLayer);

            const glare = document.createElement('div');
            glare.className = 'ui-magnifier-glare';
            frame.appendChild(glare);

            const label = document.createElement('div');
            label.className = 'ui-magnifier-label';
            frame.appendChild(label);

            document.body.appendChild(frame);

            this.frame = frame;
            this.lensLayer = lensLayer;
            this.stage = stage;
            this.glare = glare;
            this.label = label;

            this.buildFilter();

            // Копия интерфейса. Себя в неё не отдаём: иначе лупа покажет лупу, а
            // её собственные правки стиля будут без конца объявлять копию устаревшей.
            this.mirror = MySpace.snapshot.mirror({
                container: stage,
                host: document.body,
                exclude: [frame]
            });
        },

        /**
         * Фильтр искажения: карта смещений (`feImage`) + `feDisplacementMap`.
         *
         * Карта — картинка, где красный канал задаёт сдвиг по горизонтали, а
         * зелёный по вертикали (0,5 = без сдвига). Она собирается один раз и
         * растягивается на любой размер лупы; сила искажения задаётся атрибутом
         * `scale`, поэтому при изменении размера пересобирать ничего не нужно.
         */
        buildFilter: function () {
            const NS = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('class', 'ui-magnifier-defs');
            svg.setAttribute('aria-hidden', 'true');

            const defs = document.createElementNS(NS, 'defs');
            const filter = document.createElementNS(NS, 'filter');
            filter.setAttribute('id', FILTER_ID);
            // Область фильтра ровно по элементу: карта смещений растягивается на
            // неё же, и «край лупы» в карте обязан совпасть с краем элемента.
            filter.setAttribute('x', '0%');
            filter.setAttribute('y', '0%');
            filter.setAttribute('width', '100%');
            filter.setAttribute('height', '100%');
            // Без sRGB браузер считает фильтр в линейном пространстве и цвета уплывают.
            filter.setAttribute('color-interpolation-filters', 'sRGB');

            const image = document.createElementNS(NS, 'feImage');
            image.setAttribute('x', '0%');
            image.setAttribute('y', '0%');
            image.setAttribute('width', '100%');
            image.setAttribute('height', '100%');
            image.setAttribute('preserveAspectRatio', 'none');
            image.setAttribute('result', 'map');

            const displace = document.createElementNS(NS, 'feDisplacementMap');
            displace.setAttribute('in', 'SourceGraphic');
            displace.setAttribute('in2', 'map');
            displace.setAttribute('xChannelSelector', 'R');
            displace.setAttribute('yChannelSelector', 'G');
            displace.setAttribute('scale', '0');

            filter.appendChild(image);
            filter.appendChild(displace);
            defs.appendChild(filter);
            svg.appendChild(defs);
            this.frame.appendChild(svg);

            this.mapEl = image;
            this.displaceEl = displace;
        },

        /**
         * Карта смещений под пропорции экрана.
         *
         * Считается в долях: `n` — расстояние от центра, где 1 — край лупы (а не
         * край картинки: картинка шире рамки на запас). Сам профиль — в
         * `glassProfile`: середина плоская, искажение живёт только в кромке.
         * По вертикали сдвиг умножается на пропорции экрана: `scale` фильтра один
         * на обе оси, и без поправки узкая сторона искажалась бы сильнее.
         */
        buildDisplacementMap: function (aspect) {
            const n = GLASS_MAP_SIZE;
            const canvas = document.createElement('canvas');
            canvas.width = n;
            canvas.height = n;
            const ctx = canvas.getContext('2d');
            const img = ctx.createImageData(n, n);
            const edge = 1 + 2 * GLASS_MARGIN;   // край лупы внутри картинки с запасом

            for (let j = 0; j < n; j++) {
                const cy = ((j + 0.5) / n - 0.5) * 2 * edge;
                for (let i = 0; i < n; i++) {
                    const cx = ((i + 0.5) / n - 0.5) * 2 * edge;
                    const gx = glassProfile(cx);
                    const gy = glassProfile(cy) * aspect;
                    const p = (j * n + i) * 4;
                    img.data[p] = Math.round(clamp(0.5 + 0.5 * gx, 0, 1) * 255);
                    img.data[p + 1] = Math.round(clamp(0.5 + 0.5 * gy, 0, 1) * 255);
                    img.data[p + 2] = 0;
                    img.data[p + 3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);
            return canvas.toDataURL('image/png');
        },

        // ── Геометрия ────────────────────────────────────────────────────

        /** Размер лупы, запас стекла, скругление и сила искажения. */
        applyAppearance: function () {
            if (!this.frame) return;
            const screenW = window.innerWidth;
            const screenH = window.innerHeight;

            // Пропорции лупы — пропорции экрана (требование владельца).
            const lensW = Math.max(120, Math.round(screenW * this.size));
            const lensH = Math.max(80, Math.round(lensW * screenH / screenW));
            this.lensW = lensW;
            this.lensH = lensH;
            this.marginX = this.glass ? Math.round(lensW * GLASS_MARGIN) : 0;
            this.marginY = this.glass ? Math.round(lensH * GLASS_MARGIN) : 0;

            this.frame.style.width = lensW + 'px';
            this.frame.style.height = lensH + 'px';
            this.frame.style.borderRadius = this.glass ? Math.round(Math.min(lensW, lensH) * GLASS_RADIUS) + 'px' : '0';
            this.frame.classList.toggle('ui-magnifier-glassy', !!this.glass);

            this.lensLayer.style.left = (-this.marginX) + 'px';
            this.lensLayer.style.top = (-this.marginY) + 'px';
            this.lensLayer.style.width = (lensW + 2 * this.marginX) + 'px';
            this.lensLayer.style.height = (lensH + 2 * this.marginY) + 'px';

            // Копия интерфейса занимает целый экран — увеличивает её преобразование.
            this.stage.style.width = screenW + 'px';
            this.stage.style.height = screenH + 'px';

            if (this.glass) {
                const aspect = lensH / lensW;
                if (Math.abs(aspect - this.mapAspect) > 0.01) {
                    this.mapEl.setAttribute('href', this.buildDisplacementMap(aspect));
                    this.mapAspect = aspect;
                }
                this.displaceEl.setAttribute('scale', String(Math.round(2 * lensW * GLASS_EDGE_SHIFT)));
                this.lensLayer.style.filter = 'url(#' + FILTER_ID + ')';
            } else {
                this.lensLayer.style.filter = 'none';
            }
        },

        /** Перерисовка не чаще кадра: мышь присылает события гуще, чем экран рисует. */
        schedulePlace: function () {
            if (this._frameRequest) return;
            this._frameRequest = requestAnimationFrame(() => {
                this._frameRequest = 0;
                if (this.active) this.place();
            });
        },

        /**
         * Поставить лупу по указателю: рамка центром в курсор, а копия сдвинута
         * так, чтобы точка документа под курсором пришлась ровно в центр рамки.
         */
        place: function () {
            if (!this.frame) return;
            const lensW = this.lensW;
            const lensH = this.lensH;

            // Рамка двигается ПРЕОБРАЗОВАНИЕМ, а не left/top: смена координат
            // заставляет браузер пересчитывать раскладку, а внутри рамки лежит
            // копия всего интерфейса — пересчитывать её на каждое движение мыши
            // нельзя. Преобразование раскладку не трогает вовсе.
            const left = Math.round(this.mouseX - lensW / 2);
            const top = Math.round(this.mouseY - lensH / 2);
            this.frame.style.transform = 'translate(' + left + 'px,' + top + 'px)';

            const pageX = this.mouseX + (window.scrollX || 0);
            const pageY = this.mouseY + (window.scrollY || 0);
            const tx = lensW / 2 - pageX * this.zoom + this.marginX;
            const ty = lensH / 2 - pageY * this.zoom + this.marginY;
            this.stage.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + this.zoom + ')';
        },

        // ── Подпись увеличения ───────────────────────────────────────────

        /** Текущее увеличение (или размер) на секунду в углу лупы. */
        showLabel: function (text) {
            if (!this.label) return;
            this.label.textContent = text;
            this.label.classList.add('ui-magnifier-label-visible');
            if (this._labelTimer) clearTimeout(this._labelTimer);
            this._labelTimer = setTimeout(() => this.hideLabel(), LABEL_HIDE_MS);
        },

        hideLabel: function () {
            if (this._labelTimer) { clearTimeout(this._labelTimer); this._labelTimer = 0; }
            if (this.label) this.label.classList.remove('ui-magnifier-label-visible');
        }
    };

    window.MySpaceMagnifier = Magnifier;
    window.addEventListener('load', () => Magnifier.init());
})();
