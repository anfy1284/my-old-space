// Project: my-old-space
// App: listSettings
// Description: Настройки списка — вкладка Фильтры.

(function () {
    const APP_NAME = 'listSettings';

    // -----------------------------------------------------------------------
    // Константы (опции для emunList-столбцов таблицы фильтров)
    // -----------------------------------------------------------------------

    const ALL_OPERATORS = [
        { value: '=',          caption: __t('Equals') },
        { value: '!=',         caption: __t('Not equals') },
        { value: '>',          caption: __t('Greater than') },
        { value: '>=',         caption: __t('Greater than or equal') },
        { value: '<',          caption: __t('Less than') },
        { value: '<=',         caption: __t('Less than or equal') },
        { value: 'contains',   caption: __t('Contains') },
        { value: 'startsWith', caption: __t('Starts with') },
        { value: 'endsWith',   caption: __t('Ends with') },
        { value: 'isNull',     caption: __t('Is empty') },
        { value: 'isNotNull',  caption: __t('Is not empty') }
    ];

    const FILTER_TYPES = [
        { value: 'server', caption: __t('Server (SQL)') },
        { value: 'client', caption: __t('Client-side') }
    ];

    const VISIBILITIES = [
        { value: 'visible',  caption: __t('Visible (editable)') },
        { value: 'readonly', caption: __t('Visible (read-only)') },
        { value: 'hidden',   caption: __t('Hidden') }
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
                    appForm.setTitle(__t('Settings') + ': ' + targetTitle);
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
                            type: 'group',
                            noBorder: true,
                            orientation: 'vertical',
                            layout: [{
                            type: 'tabs',
                            name: 'mainTabs',
                            tabs: [
                                {
                                    caption: __t('Filters'),
                                    layout: [
                                        {
                                            type: 'table',
                                            name: 'filtersTable',
                                            data: '__filters',
                                            columns: [
                                                { caption: __t('On'),         data: 'enabled',    inputType: 'checkbox', width: 35  },
                                                { caption: __t('Field'),      data: 'field',      inputType: 'emunList', options: fieldOptions,  width: 155 },
                                                { caption: __t('Condition'),  data: 'operator',   inputType: 'emunList', options: ALL_OPERATORS, width: 150 },
                                                { caption: __t('Value'),      data: 'value',      inputType: 'textbox',  width: 135 },
                                                { caption: __t('Type'),       data: 'type',       inputType: 'emunList', options: FILTER_TYPES,  width: 125 },
                                                { caption: __t('Visibility'), data: 'visibility', inputType: 'emunList', options: VISIBILITIES,  width: 175 }
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
                                                { type: 'button', caption: __t('+ Add filter'), action: 'addFilter',    properties: { isStandard: false } },
                                                { type: 'button', caption: __t('Delete'),       action: 'deleteFilter', properties: { isStandard: false } },
                                                { type: 'button', caption: __t('Apply'),        action: 'applyFilters', properties: { isStandard: false } },
                                                { type: 'button', caption: __t('Clear all'),    action: 'clearFilters', properties: { isStandard: false } }
                                            ]
                                        }
                                    ]
                                },
                                {
                                    caption: __t('Fields'),
                                    layout: []
                                }
                            ]
                        }]
                        }
                    ];

                    const content = appForm.contentArea || (appForm.getContentArea && appForm.getContentArea());
                    if (!content) return;
                    content.innerHTML = '';
                    content.style.padding = '8px';
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
