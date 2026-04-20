(function () {
    const APP_NAME = 'cpp_app';

    const descriptor = {
        config: { allowMultipleInstances: true },

        createInstance: async function (params) {
            const openParams = params || {};
            const programName = openParams.program || 'CppApp';
            const wasmJsUrl = `/apps/cpp_app/resources/public/${programName}.js`;
            const factoryFuncName = 'create' + programName;

            const appForm = new DataForm(APP_NAME);
            appForm.setTitle('C++ Application: ' + programName);
            appForm.setWidth(600);
            appForm.setHeight(400);
            appForm.setAnchorToWindow('center');

            let outputArea = null;

            function print(text) {
                if (!outputArea) return;
                outputArea.value += text + '\n';
                outputArea.scrollTop = outputArea.scrollHeight;
            }

            function loadWasmModule() {
                const script = document.createElement('script');
                script.src = wasmJsUrl;
                script.onload = () => {
                    if (typeof window[factoryFuncName] === 'function') {
                        print('Loading WebAssembly module (' + programName + ')...');
                        window[factoryFuncName]({
                            print: function (text) { print(text); },
                            printErr: function (text) { print('[ERR] ' + text); },
                            canvas: null
                        }).then(() => {
                            print('Module loaded successfully!');
                        }).catch(err => {
                            print('Error loading module: ' + err);
                        });
                    } else {
                        print('Error: ' + factoryFuncName + ' function not found. Build might be incorrect.');
                    }
                };
                script.onerror = () => { print('Failed to load ' + wasmJsUrl); };
                document.body.appendChild(script);
            }

            const instance = {
                appName: APP_NAME,
                form: appForm,

                onOpen: async () => {
                    appForm.getLayoutWithData = async () => ({ layout: [], data: [] });
                    await appForm.Draw();

                    const content = appForm.contentArea || (appForm.getContentArea && appForm.getContentArea());
                    if (!content) return;
                    content.innerHTML = '';
                    content.style.padding = '0';

                    outputArea = document.createElement('textarea');
                    outputArea.style.width = '100%';
                    outputArea.style.height = '100%';
                    outputArea.style.backgroundColor = 'black';
                    outputArea.style.color = '#00ff00';
                    outputArea.style.fontFamily = 'monospace';
                    outputArea.style.border = 'none';
                    outputArea.style.resize = 'none';
                    outputArea.readOnly = true;
                    content.appendChild(outputArea);

                    loadWasmModule();
                },

                onAction: async () => false,

                destroy: () => {
                    try { appForm.close(); } catch (e) {}
                }
            };

            appForm.instance = instance;
            await instance.onOpen();
            return instance;
        }
    };

    if (window.MySpace) {
        window.MySpace.register(APP_NAME, descriptor);
    } else {
        console.error('[cpp_app] window.MySpace not found!');
    }
})();
