{
    // Load the WebAssembly module
    const params = (window.AppParams && window.AppParams['cpp_app']) || {};
    const programName = params.program || 'CppApp';
    const wasmJsUrl = `/apps/cpp_app/resources/public/${programName}.js`;
    const factoryFuncName = 'create' + programName;

    const form = new Form();
    form.setTitle('C++ Application: ' + programName);
    form.setX(100);
    form.setY(100);
    form.setWidth(600);
    form.setHeight(400);
    form.setAnchorToWindow('center');

    // Create a text area to show output
    const outputArea = document.createElement('textarea');
    outputArea.style.width = '100%';
    outputArea.style.height = '100%';
    outputArea.style.backgroundColor = 'black';
    outputArea.style.color = '#00ff00';
    outputArea.style.fontFamily = 'monospace';
    outputArea.style.border = 'none';
    outputArea.style.resize = 'none';
    outputArea.readOnly = true;

    form.Draw(document.body);
    form.getContentArea().appendChild(outputArea);

    // Function to append text to the output area
    function print(text) {
        outputArea.value += text + '\n';
        outputArea.scrollTop = outputArea.scrollHeight;
    }

    // Check if script is already loaded to avoid re-declaring the global function if not modularized properly,
    // but since we use MODULARIZE, we get a factory function.
    // However, we need to load the script tag to get that factory function into the global scope (or handle it manually).

    const script = document.createElement('script');
    script.src = wasmJsUrl;
    script.onload = () => {
        if (typeof window[factoryFuncName] === 'function') {
            print(`Loading WebAssembly module (${programName})...`);
            window[factoryFuncName]({
                print: function (text) {
                    print(text);
                },
                printErr: function (text) {
                    print('[ERR] ' + text);
                },
                canvas: null // No canvas for now, just text
            }).then(module => {
                print('Module loaded successfully!');
                // The main() function in C++ is automatically called by default in Emscripten
                // unless we set -s INVOKE_RUN=0. 
                // If main() returns, the program exits.
            }).catch(err => {
                print('Error loading module: ' + err);
            });
        } else {
            print(`Error: ${factoryFuncName} function not found. Build might be incorrect.`);
        }
    };
    script.onerror = () => {
        print('Failed to load ' + wasmJsUrl);
    };
    document.body.appendChild(script);
}
