/**
 * imageViewer — просмотр картинки в отдельном окне на весь экран.
 *
 * Открывается так:
 *     MySpace.open('imageViewer', { url: '/app/messenger/attachment?uid=…', name: 'screen.png' })
 *
 * Зачем отдельное окно. Раньше вложение разворачивалось прямо в ленте переписки:
 * лента прыгала, а картинку всё равно было не рассмотреть — её ширина ограничена
 * шириной окна мессенджера. Окно просмотра открывается развёрнутым, не мешает
 * переписке (её видно за ним) и закрывается как любое другое.
 *
 * Разметка — обычный лейаут с контролом `image`; ручного DOM здесь нет намеренно.
 */
try {
    (function () {
        'use strict';

        var APP_NAME = 'imageViewer';

        /**
         * Что сейчас показываем. ОБЪЕКТ, а не пара переменных: окно одно и живёт
         * дольше картинки — кнопка «Сохранить», запомнившая адрес первой картинки,
         * сохраняла бы её и через десять открытий.
         */
        function newState(params) {
            return {
                url: (params && params.url) || '',
                name: (params && params.name) || ''
            };
        }

        function buildForm(state) {
            var form = new DataForm(APP_NAME);
            form.setTitle(state.name || __t('imgview_caption'));
            form.setFormIcon('/apps/general_icons/resources/public/16x16/preview.png');

            form.getLayoutWithData = async function () {
                return {
                    // Развёрнутое окно — умолчание лейаута: смотреть картинку в
                    // четверти экрана незачем, а уменьшить окно человек всегда может.
                    windowState: 'maximized',
                    layout: [
                        {
                            type: 'image',
                            name: 'picture',
                            // Адрес приходит данными формы (`data` ниже), а не свойством:
                            // так же, как значение в любое другое поле лейаута.
                            data: 'picture',
                            properties: { fit: 'contain', background: '#000000', alt: state.name }
                        },
                        {
                            type: 'group',
                            orientation: 'horizontal',
                            noBorder: true,
                            layout: [
                                {
                                    type: 'button', name: 'btnSave',
                                    caption: __t('imgview_save'),
                                    icon: '/apps/general_icons/resources/public/16x16/download.png'
                                },
                                {
                                    type: 'button', name: 'btnClose',
                                    caption: __t('imgview_close'),
                                    icon: '/apps/general_icons/resources/public/16x16/cancel.png'
                                }
                            ]
                        }
                    ],
                    data: [{ name: 'picture', value: state.url }]
                };
            };

            return form;
        }

        /**
         * Привязка кнопок. Серверных скриптов у окна нет, поэтому обработчики
         * навешиваются здесь — как в printPreview. Читают `state`, а не копии
         * значений: картинка в окне меняется.
         */
        function wireButtons(form, state) {
            var save = form.getControl && form.getControl('btnSave');
            var close = form.getControl && form.getControl('btnClose');
            if (save) save.onClick = function () { MySpace.downloadFile(state.url, state.name); };
            if (close) close.onClick = function () { form.close(); };
        }

        /** Показать другую картинку в уже открытом окне. */
        function showImage(form, state, params) {
            state.url = (params && params.url) || state.url;
            state.name = (params && params.name) || '';
            var pic = form.getControl && form.getControl('picture');
            if (pic && typeof pic.setSrc === 'function') pic.setSrc(state.url);
            if (pic && typeof pic.setAlt === 'function') pic.setAlt(state.name);
            try { form.setTitle(state.name || __t('imgview_caption')); } catch (e) {}
        }

        // Окно одно: повторное открытие не плодит копии, а подменяет картинку в
        // уже готовом окне (см. onOpen).
        var app = new App(APP_NAME, { config: { allowMultipleInstances: false } });

        app.createInstance = async function (params) {
            var instanceId = this.generateInstanceId();
            var state = newState(params);

            var form = buildForm(state);
            await form.Draw(document.body);
            wireButtons(form, state);

            var instance = {
                id: instanceId,
                appName: APP_NAME,
                form: form,

                onOpen: function (openParams) {
                    if (!openParams || !openParams.url) return;
                    showImage(this.form, state, openParams);
                    if (typeof this.form.restore === 'function') this.form.restore();
                },

                destroy: function () {
                    try { if (this.form && this.form.close) this.form.close(); } catch (e) {}
                }
            };

            form.instance = instance;
            return instance;
        };

        try { app.register(); } catch (e) { console.error('[imageViewer] register failed:', e); }
    })();
} catch (error) {
    console.error('[imageViewer] init error:', error);
}
