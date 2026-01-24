#!/usr/bin/env node

/**
 * Скрипт для создания скелета нового приложения в my-old-space
 * 
 * Использование:
 *   node createApp.js <appName>
 * 
 * Пример:
 *   node createApp.js myNewApp
 */

const fs = require('fs');
const path = require('path');

// Получаем имя приложения из аргументов командной строки
const appName = process.argv[2];

if (!appName) {
    console.error('Ошибка: Необходимо указать имя приложения!');
    console.log('Использование: node createApp.js <appName>');
    process.exit(1);
}

// Валидация имени приложения
if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
    console.error('Ошибка: Имя приложения может содержать только буквы, цифры, дефис и подчеркивание!');
    process.exit(1);
}

// Определяем пути
const projectRoot = path.resolve(__dirname, '../../../'); // Корень проекта (где находится apps.json)
const appsDir = path.join(projectRoot, 'apps');
const appDir = path.join(appsDir, appName);
const appsJsonPath = path.join(projectRoot, 'apps.json');

console.log(`\n🚀 Создание нового приложения: ${appName}`);
console.log(`📁 Путь: ${appDir}\n`);

// Проверяем, существует ли папка приложения
if (fs.existsSync(appDir)) {
    console.error(`❌ Ошибка: Приложение с именем "${appName}" уже существует!`);
    process.exit(1);
}

// Создаем структуру папок
try {
    console.log('📂 Создание структуры папок...');
    
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.join(appDir, 'resources', 'public'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'db'), { recursive: true });
    
    console.log('   ✓ apps/' + appName);
    console.log('   ✓ apps/' + appName + '/resources/public');
    console.log('   ✓ apps/' + appName + '/db');
    
} catch (error) {
    console.error('❌ Ошибка при создании папок:', error.message);
    process.exit(1);
}

// Создаем config.json
try {
    console.log('\n📝 Создание config.json...');
    
    const config = {
        "level": "app",
        "autoStart": false,
        "system": ["mySpace"],
        "access": ["admin", "user"],
        "dependencies": {},
        "mainMenuCommands": [
            {
                "id": "main",
                "items": [
                    {
                        "caption": "Neues",
                        "items": [
                            {
                                "caption": appName,
                                "action": "open"
                            }
                        ]
                    }
                ]
            }
        ]
    };
    
    fs.writeFileSync(
        path.join(appDir, 'config.json'),
        JSON.stringify(config, null, 4),
        'utf8'
    );
    
    console.log('   ✓ config.json создан');
    
} catch (error) {
    console.error('❌ Ошибка при создании config.json:', error.message);
    process.exit(1);
}

// Создаем init.js
try {
    console.log('📝 Создание init.js...');
    
    const initContent = `/**
 * Initialization for ${appName} application
 */

module.exports = async function(modelsDB) {
    console.log('[${appName}/init] Initialization complete');
};
`;
    
    fs.writeFileSync(
        path.join(appDir, 'init.js'),
        initContent,
        'utf8'
    );
    
    console.log('   ✓ init.js создан');
    
} catch (error) {
    console.error('❌ Ошибка при создании init.js:', error.message);
    process.exit(1);
}

// Создаем server.js
try {
    console.log('📝 Создание server.js...');
    
    const serverContent = `const { registerDynamicTableMethods } = require('../../node_modules/my-old-space/drive_root/dynamicTableRegistry');

// Регистрация стандартных методов для работы с таблицами
const dynamicTableMethods = registerDynamicTableMethods('${appName}', {
    // Маппинг таблиц на модели
    tables: {
        // Пример: 'table_name': 'ModelName'
    },
    // Конфигурация полей для каждой таблицы
    tableFields: {
        // Пример конфигурации таблицы:
        // 'table_name': [
        //     {
        //         name: 'id',
        //         caption: 'ID',
        //         type: 'INTEGER',
        //         width: 80,
        //         source: 'field',
        //         editable: false
        //     }
        // ]
    }
});

// Экспортируем методы для использования в приложении
module.exports = {
    ...dynamicTableMethods,
    
    // Дополнительные кастомные методы можно добавить здесь
};
`;
    
    fs.writeFileSync(
        path.join(appDir, 'server.js'),
        serverContent,
        'utf8'
    );
    
    console.log('   ✓ server.js создан');
    
} catch (error) {
    console.error('❌ Ошибка при создании server.js:', error.message);
    process.exit(1);
}

// Создаем db/db.json
try {
    console.log('📝 Создание db/db.json...');
    
    const dbConfig = {
        "models": [],
        "associations": []
    };
    
    fs.writeFileSync(
        path.join(appDir, 'db', 'db.json'),
        JSON.stringify(dbConfig, null, 4),
        'utf8'
    );
    
    console.log('   ✓ db/db.json создан');
    
} catch (error) {
    console.error('❌ Ошибка при создании db/db.json:', error.message);
    process.exit(1);
}

// Создаем client.js с шаблоном, использующим базовый `App`
try {
    console.log('📝 Создание resources/public/client.js...');

    const clientContent = `/**
 * ${appName} Application - Client Side (generated)
 *
 * This scaffold uses the framework ` + 'App' + ` helper. Apps that need a UI
 * should override ` + 'createInstance' + ` and create their own ` + 'Form' + ` / ` + 'DataForm' + `.
 */

try {
    (function() {
        const APP_NAME = '${appName}';

        // Create App helper and override instance creation when a form is needed
        const app = new App(APP_NAME, { config: { allowMultipleInstances: false } });

        // Override createInstance to create a DataForm for this app only
        app.createInstance = async function(params) {
            const instanceId = this.generateInstanceId();
            const container = null; // no global container by default

            const appForm = new DataForm(APP_NAME);
            appForm.setTitle(APP_NAME);
            appForm.setWidth(800);
            appForm.setHeight(600);
            appForm.setX(100);
            appForm.setY(100);

            // Example Draw extension — apps can customize their layout instead
            const originalDraw = typeof appForm.Draw === 'function' ? appForm.Draw.bind(appForm) : null;
            appForm.Draw = function(parent) {
                if (originalDraw) originalDraw(parent);
                try {
                    const contentArea = this.getContentArea();
                    if (contentArea) {
                        contentArea.style.display = 'flex';
                        contentArea.style.flexDirection = 'column';
                        contentArea.style.padding = '10px';
                        const welcomeText = document.createElement('div');
                        welcomeText.textContent = 'Добро пожаловать в приложение ' + APP_NAME + '!';
                        contentArea.appendChild(welcomeText);
                    }
                } catch (e) { /* ignore */ }
            };

            const instance = {
                id: instanceId,
                appName: APP_NAME,
                container,
                form: appForm,
                onOpen(openParams) {
                    const tableName = openParams && (openParams.dbTable || openParams.table);
                    if (tableName) appForm.dbTable = tableName;
                    try { appForm.Draw(); } catch (e) { console.error(e); }
                },
                onAction(action, params) {
                    try { if (typeof appForm.doAction === 'function') appForm.doAction(action, params); } catch (e) { console.error(e); }
                },
                destroy() {
                    try { if (typeof appForm.destroy === 'function') appForm.destroy(); } catch (e) {}
                }
            };

            if (params && (params.dbTable || params.table)) instance.onOpen(params);
            return instance;
        };

        try { app.register(); } catch (e) { console.error('Failed to register app descriptor', e); }

    })();

} catch (error) {
    console.error('[${appName}] Error initializing client descriptor:', error);
}
`;

    fs.writeFileSync(
        path.join(appDir, 'resources', 'public', 'client.js'),
        clientContent,
        'utf8'
    );

    console.log('   ✓ resources/public/client.js создан');

} catch (error) {
    console.error('❌ Ошибка при создании client.js:', error.message);
    process.exit(1);
}

// Обновляем apps.json
try {
    console.log('\n📋 Обновление apps.json...');
    
    let appsConfig;
    
    if (fs.existsSync(appsJsonPath)) {
        const appsJsonContent = fs.readFileSync(appsJsonPath, 'utf8');
        appsConfig = JSON.parse(appsJsonContent);
    } else {
        appsConfig = {
            "path": "/apps",
            "apps": []
        };
    }
    
    // Проверяем, не добавлено ли уже приложение
    const appExists = appsConfig.apps.some(app => app.name === appName);
    
    if (!appExists) {
        appsConfig.apps.push({
            "name": appName,
            "path": `/${appName}`
        });
        
        fs.writeFileSync(
            appsJsonPath,
            JSON.stringify(appsConfig, null, 4),
            'utf8'
        );
        
        console.log('   ✓ Приложение добавлено в apps.json');
    } else {
        console.log('   ℹ Приложение уже есть в apps.json');
    }
    
} catch (error) {
    console.error('❌ Ошибка при обновлении apps.json:', error.message);
    console.log('⚠️  Вам нужно будет добавить приложение в apps.json вручную');
}

console.log('\n✅ Приложение успешно создано!');
console.log('\n📖 Следующие шаги:');
console.log('   1. Настройте модели данных в db/db.json');
console.log('   2. Добавьте логику на сервере в server.js');
console.log('   3. Создайте интерфейс в resources/public/client.js');
console.log('   4. Перезапустите сервер для применения изменений\n');
