// Project: my-old-space
// App: listSettings
// Description: Настройки списка — вкладка Фильтры.

(function () {
    const APP_NAME = 'listSettings';

    // -----------------------------------------------------------------------
    // Константы (опции для emunList-столбцов таблицы фильтров)
    // -----------------------------------------------------------------------

    const ALL_OPERATORS = [
        { value: '=',          caption: 'Равно' },
        { value: '!=',         caption: 'Не равно' },
        { value: '>',          caption: 'Больше' },
        { value: '>=',         caption: 'Больше или равно' },
        { value: '<',          caption: 'Меньше' },
        { value: '<=',         caption: 'Меньше или равно' },
        { value: 'contains',   caption: 'Содержит' },
        { value: 'startsWith', caption: 'Начинается с' },
        { value: 'endsWith',   caption: 'Заканчивается на' },
        { value: 'isNull',     caption: 'Не задано' },
        { value: 'isNotNull',  caption: 'Задано' }
    ];

    const FILTER_TYPES = [
        { value: 'server', caption: 'Серверный (SQL)' },
        { value: 'client', caption: 'Клиентский' }
    ];

    const VISIBILITIES = [
        { value: 'visible',  caption: 'Видимый (редактируемый)' },
        { value: 'readonly', caption: 'Видимый (только чтение)' },
        { value: 'hidden',   caption: 'Скрытый' }
    ];

    // -----------------------------------------------------------------------
    // Дескриптор приложения
    // -----------------------------------------------------------------------

    const descriptor = {
        config: { allowMultipleInstances: true },

        createInstance: async function (params) {
            const appForm = new DataForm(APP_NAME);
            appForm.setWidth(800);
            appForm.setHeight(460);
            appForm.setModal(true);

            const instance = {
                appName: APP_NAME,
                form: appForm,

                onOpen: async (openParams) => {
                    const targetTitle = openParams.title || openParams.appName || 'списка';
                    appForm.setTitle('Настройки: ' + targetTitle);
                    appForm.params = openParams;

                    // tableInstance — ссылка на DynamicTable, переданная из кнопки «Настройки»
                    const tableInst = openParams.tableInstance || null;
                    const columns   = (tableInst && Array.isArray(tableInst.columns)) ? tableInst.columns : [];

                    // Глубокая копия текущих фильтров — изменения применяем только по «Применить»
                    const currentFilters = tableInst ? JSON.parse(JSON.stringify(tableInst.getFilters())) : [];

                    // Опции для столбца «Поле»
                    const fieldOptions = columns.map(c => ({ value: c.data, caption: c.caption || c.data }));

                    // Форма строит DOM на клиенте — серверный layout не нужен
                    appForm.getLayoutWithData = async () => ({ layout: [], data: [] });
                    await appForm.Draw();

                    // Инициализируем _dataMap и регистрируем данные фильтров
                    if (!appForm._dataMap) appForm._dataMap = {};
                    appForm._dataMap['__filters'] = {
                        name: '__filters',
                        value: currentFilters,
                        tabularSection: false
                    };

                    // ---- Обработчик действий кнопок ----
                    appForm.doAction = (action /*, params */) => {
                        const arr = appForm._dataMap['__filters'].value;
                        const tbl = appForm.controlsMap && appForm.controlsMap['filtersTable'];

                        if (action === 'addFilter') {
                            const firstCol = columns[0];
                            arr.push({
                                field:      firstCol ? firstCol.data                  : '',
                                caption:    firstCol ? (firstCol.caption || firstCol.data) : '',
                                operator:   '=',
                                value:      '',
                                type:       'server',
                                visibility: 'visible',
                                enabled:    true
                            });
                            if (tbl && typeof tbl._invokeRenderBodyRows === 'function') tbl._invokeRenderBodyRows();
                            return;
                        }

                        if (action === 'deleteFilter') {
                            if (!tbl) return;
                            const idx = tbl._activeRowIndex;
                            if (idx < 0) return;
                            if (Array.isArray(arr) && idx < arr.length) {
                                arr.splice(idx, 1);
                                tbl._activeRowIndex = -1;
                                if (typeof tbl._invokeRenderBodyRows === 'function') tbl._invokeRenderBodyRows();
                            }
                            return;
                        }

                        if (action === 'applyFilters') {
                            if (tableInst) tableInst.setFilters(Array.isArray(arr) ? arr : []);
                            return;
                        }

                        if (action === 'clearFilters') {
                            appForm._dataMap['__filters'].value = [];
                            if (tableInst) tableInst.clearFilters();
                            if (tbl && typeof tbl._invokeRenderBodyRows === 'function') tbl._invokeRenderBodyRows();
                            return;
                        }
                    };

                    // ---- Описание интерфейса исключительно через UI_classes ----
                    const layout = [
                        {
                            type: 'tabs',
                            name: 'mainTabs',
                            tabs: [
                                {
                                    caption: 'Фильтры',
                                    layout: [
                                        {
                                            type: 'table',
                                            name: 'filtersTable',
                                            data: '__filters',
                                            columns: [
                                                { caption: 'Вкл',       data: 'enabled',    inputType: 'checkbox', width: 35  },
                                                { caption: 'Поле',      data: 'field',      inputType: 'emunList', options: fieldOptions,  width: 155 },
                                                { caption: 'Условие',   data: 'operator',   inputType: 'emunList', options: ALL_OPERATORS, width: 150 },
                                                { caption: 'Значение',  data: 'value',      inputType: 'textbox',  width: 135 },
                                                { caption: 'Тип',       data: 'type',       inputType: 'emunList', options: FILTER_TYPES,  width: 125 },
                                                { caption: 'Видимость', data: 'visibility', inputType: 'emunList', options: VISIBILITIES,  width: 175 }
                                            ],
                                            properties: {
                                                editMode: 'row-activate',
                                                visibleRows: 8,
                                                showToolbar: false
                                            }
                                        },
                                        {
                                            type: 'group',
                                            orientation: 'horizontal',
                                            layout: [
                                                { type: 'button', caption: '+ Добавить фильтр', action: 'addFilter',    properties: { isStandard: false } },
                                                { type: 'button', caption: 'Удалить',           action: 'deleteFilter', properties: { isStandard: false } },
                                                { type: 'button', caption: 'Применить',         action: 'applyFilters', properties: { isStandard: false } },
                                                { type: 'button', caption: 'Очистить всё',      action: 'clearFilters', properties: { isStandard: false } }
                                            ]
                                        }
                                    ]
                                },
                                {
                                    caption: 'Поля',
                                    layout: []
                                }
                            ]
                        }
                    ];

                    const content = appForm.contentArea || (appForm.getContentArea && appForm.getContentArea());
                    if (!content) return;
                    content.innerHTML = '';
                    content.style.padding = '0';
                    await appForm.renderLayout(content, layout);
                },

                onAction: async () => false,

                destroy: () => { try { appForm.close(); } catch (e) {} }
            };

            appForm.instance = instance;
            await instance.onOpen(params);
            return instance;
        }
    };

    if (window.MySpace) {
        window.MySpace.register(APP_NAME, descriptor);
    } else {
        console.error('[listSettings] window.MySpace not found!');
    }
})();
