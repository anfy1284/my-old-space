# Как создать новый проект на базе фреймворка my-old-space

Этот документ описывает процесс создания нового приложения, использующего ядро `my-old-space`.

## Шаг 1. Подготовка папки

Создайте новую пустую папку для вашего проекта (например, `my-new-project`).
Откройте эту папку в VS Code или терминале.

## Шаг 2. Создание файлов конфигурации

В корне новой папки создайте следующие 6 файлов:

### 1. `package.json`
Этот файл определяет зависимости. Важно указать правильный путь к фреймворку.

**Вариант А: Локальная разработка (если фреймворк лежит рядом в папке)**
Укажите относительный путь к папке `packages/my-old-space`.
```json
{
  "name": "my-new-project",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "my-old-space": "file:../hode_js_drive/packages/my-old-space"
  }
}
```

**Вариант Б: Использование из GitHub (рекомендуется для деплоя)**
Укажите прямую ссылку на репозиторий с указанием пути к пакету внутри него.
```json
{
  "name": "my-new-project",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "my-old-space": "git+https://github.com/anfy1284/OldSpace.git#path:packages/my-old-space"
  }
}
```
*> **Важно:** Синтаксис `#path:packages/my-old-space` необходим, так как пакет находится в подпапке репозитория. Если вы опубликуете фреймворк в npm, строку можно будет заменить на `"my-old-space": "^1.0.0"`.*

### 2. `index.js`
Точка входа в приложение. Важно: обязательно передавайте параметр `rootPath` и `config` в функцию запуска фреймворка!

```javascript
const { start } = require('my-old-space');
const path = require('path');
const config = require('./server.config.json');

// Запускаем фреймворк, обязательно передавая rootPath и config
start({
  rootPath: __dirname,
  config
});
```

> **Важно:** Если не передать rootPath, фреймворк не сможет использовать настройки вашей базы данных из dbSettings.json в корне проекта!

### 3. `server.config.json`
Настройки веб-сервера.

```json
{
  "level": "root",
  "appAlias": "app",
  "appIndexPage": "index.html"
}
```

### 4. `dbSettings.json` и файлы конфигурации СУБД
Фреймворк поддерживает несколько СУБД (PostgreSQL и SQLite). Основной файл `dbSettings.json` указывает, какой диалект использовать. Остальные файлы содержат специфичные настройки.

**dbSettings.json**
```json
{
  "dialect": "sqlite"
}
```

**Если используете SQLite (`dbSettings.sqlite.json`):**
```json
{
    "dialect": "sqlite",
    "storage": "./db/database.sqlite"
}
```

**Если используете PostgreSQL (`dbSettings.postgres.json`):**
```json
{
  "dialect": "postgres",
  "host": "localhost",
  "port": 5432,
  "username": "postgres",
  "password": "your_password",
  "database": "new_project_db"
}
```

### 5. `.gitignore`
Этот файл нужен для того, чтобы не отправлять в Git системный мусор и тяжелые папки библиотек.

```text
node_modules/
.venv/
.env
*.log
db/*.sqlite
```

### 6. `apps.json` (Опционально)
Если вы хотите добавить свои приложения, создайте этот файл. Он позволяет регистрировать новые приложения на уровне проекта.

```json
{
  "path": "/apps",
  "apps": [
    {
      "name": "my-custom-app",
      "path": "/my-custom-app"
    }
  ]
}
```

## Шаг 3. Установка и запуск

1.  Откройте терминал в папке нового проекта.
2.  Установите зависимости:
    ```bash
    npm install
    ```
3.  Запустите проект:
    ```bash
    npm start
    ```

Фреймворк автоматически:
- Подключится к базе данных.
- Создаст необходимые таблицы, если их нет.
- Запустит встроенные приложения (Login, Messenger, FileSystem и др.).
- Запустит веб-сервер на порту 3000 (или 80 в продакшене).

## Шаг 4. Добавление своих приложений (Опционально)

Если вы хотите добавить уникальные приложения только для этого проекта:

1.  Создайте папку `apps` в корне проекта.
2.  Внутри создайте папку для вашего приложения (например, `apps/my-custom-app`).
3.  Создайте файл `apps.json` в корне проекта (если еще не создали) и зарегистрируйте ваше приложение в нем.
4.  Фреймворк автоматически подхватит его при старте (включая модели базы данных, клиентские скрипты и WebSockets).
