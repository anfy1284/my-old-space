/**
 * printPreview — фреймворковое приложение для предварительного просмотра и печати
 * HTML-документов.
 *
 * Открывается через: window.MySpace.open('printPreview', { html: '<html>...</html>' })
 *
 * Использует DataForm + layout-паттерн (htmlViewer + кнопки).
 */
try {
    (async function () {
        const APP_NAME = 'printPreview';

        const app = new App(APP_NAME, { config: { allowMultipleInstances: true } });

        app.createInstance = async function (params) {
            const instanceId = this.generateInstanceId();

            const appForm = new DataForm(APP_NAME);
            appForm.setTitle('Druckvorschau');
            appForm.setWidth(820);
            appForm.setHeight(700);
            appForm.setAnchorToWindow('center');

            // Лейаут: htmlViewer + кнопки «Печать» и «Закрыть»
            const previewLayout = [
                {
                    type: 'htmlViewer',
                    name: 'preview',
                    height: '100%',
                    border: 'none'
                },
                {
                    type: 'group',
                    caption: '',
                    orientation: 'horizontal',
                    layout: [
                        { type: 'button', name: 'btnPrint', caption: 'Drucken',   events: { onClick: 'doPrint' } },
                        { type: 'button', name: 'btnClose', caption: 'Schließen', events: { onClick: 'doClose' } }
                    ]
                }
            ];

            // Клиентские функции формы
            const htmlContent = (params && params.html) || '';

            appForm.getLayoutWithData = async function () {
                return {
                    layout: previewLayout,
                    data: [{ name: '_html', value: htmlContent }],
                    datasetId: null,
                    clientScript: null
                };
            };

            appForm.loadData = async function () {
                this._dataMap = { _html: { name: '_html', value: htmlContent } };
            };

            appForm.Draw();

            // После отрисовки — вставить HTML в htmlViewer
            setTimeout(function () {
                var viewer = appForm.controlsMap && appForm.controlsMap['preview'];
                if (viewer && htmlContent) viewer.setValue(htmlContent);
            }, 50);

            // Привязка кнопок вручную (без loadScript, т.к. нет серверных скриптов)
            setTimeout(function () {
                var btnPrint = appForm.controlsMap && appForm.controlsMap['btnPrint'];
                var btnClose = appForm.controlsMap && appForm.controlsMap['btnClose'];
                if (btnPrint && btnPrint.element) {
                    btnPrint.element.addEventListener('click', function () {
                        var viewer = appForm.controlsMap['preview'];
                        if (viewer && typeof viewer.print === 'function') viewer.print();
                    });
                }
                if (btnClose && btnClose.element) {
                    btnClose.element.addEventListener('click', function () {
                        if (typeof appForm.Close === 'function') appForm.Close();
                        else if (typeof appForm.destroy === 'function') appForm.destroy();
                    });
                }
            }, 100);

            const instance = {
                id: instanceId,
                appName: APP_NAME,
                form: appForm,
                onOpen: function (openParams) {
                    if (openParams && openParams.html) {
                        var viewer = appForm.controlsMap && appForm.controlsMap['preview'];
                        if (viewer) viewer.setValue(openParams.html);
                    }
                },
                destroy: function () {
                    try { if (typeof appForm.destroy === 'function') appForm.destroy(); } catch (e) {}
                }
            };

            return instance;
        };

        app.register();
        console.log('[' + APP_NAME + '] Client descriptor registered via App helper');
    })();
} catch (e) {
    console.error('[printPreview] Error initializing client descriptor:', e);
}
