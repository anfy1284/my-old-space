# Техническое задание: Каскадная инициализация базы данных

## Обзор архитектуры

Трёхуровневая архитектура для формирования базы данных:
1. **drive_root** - базовый уровень
2. **drive_forms** - промежуточный уровень
3. **apps** - уровень приложений

## Принципы работы

### Каскадность снизу вверх (для сбора моделей)
```
drive_root (ИНИЦИАТОР)
  ↓ вызывает
drive_forms.collectModels()
  ↓ вызывает
apps[0].db.json, apps[1].db.json, ...
  ↑ возвращают модели
drive_forms
  ↑ возвращает все модели
drive_root (СОЗДАЕТ ВСЕ ТАБЛИЦЫ)
```

### Разделение ответственности

#### drive_root/db/createDB.js (ГЛАВНЫЙ)
**Ответственность:**
- Инициирует весь процесс
- Собирает модели с ВСЕХ уровней через вызов функций (НЕ spawn)
- Объединяет модели (merge) с разных уровней
- СОЗДАЕТ все таблицы в БД
- Выполняет миграции (backup → drop → create → restore)
- Каскадно заполняет defaultValues для ВСЕХ уровней

**НЕ ДОЛЖЕН:**
- ❌ Напрямую обращаться к папке `../../apps`
- ❌ Запускать drive_forms через spawn/exec
- ❌ Знать про apps напрямую

**Экспортирует:**
- Ничего (только main entry point)

---

#### drive_forms/db/createDB.js (КОЛЛЕКТОР)
**Ответственность:**
- Собирает модели своего уровня (drive_forms)
- Проходит по всем apps через apps.json
- Собирает модели со всех apps
- Собирает defaultValues со всех apps
- Собирает динамические данные (systems, access_roles) из config.json приложений

**НЕ ДОЛЖЕН:**
- ❌ Создавать таблицы
- ❌ Работать с Sequelize напрямую
- ❌ Выполнять миграции

**Экспортирует:**
```javascript
module.exports = { collectModels };

// Возвращает:
{
  models: [...],  // Массив определений моделей
  defaultValuesByLevel: {
    'drive_forms': { systems: [...], access_roles: [...], ... },
    'appName1': { tableName: [...], ... },
    'appName2': { tableName: [...], ... }
  }
}
```

---

#### apps/*/db/db.json (ДЕКЛАРАТИВНЫЙ)
**Ответственность:**
- Только описание моделей таблиц приложения
- Статические данные (не код)

**Формат:**
```json
{
  "models": [
    {
      "name": "ModelName",
      "tableName": "table_name",
      "fields": { ... },
      "options": { ... }
    }
  ]
}
```

---

## Детальный алгоритм работы

### 1. Сбор моделей (drive_root → drive_forms → apps)

```javascript
// drive_root/db/createDB.js
function collectAllModels() {
  // 1. Берем модели drive_root
  let allModels = [...modelsDef];
  let defaultValuesByLevel = { [LEVEL]: defaultValues };
  
  // 2. Вызываем drive_forms.collectModels()
  const formsModule = require('../../drive_forms/db/createDB.js');
  const formsData = formsModule.collectModels();
  
  // 3. Добавляем модели drive_forms + apps
  allModels = allModels.concat(formsData.models);
  defaultValuesByLevel = { ...defaultValuesByLevel, ...formsData.defaultValuesByLevel };
  
  return { models: allModels, defaultValuesByLevel };
}
```

```javascript
// drive_forms/db/createDB.js
function collectModels() {
  // 1. Берем модели drive_forms
  let allModels = [...modelsDef];
  let defaultValuesByLevel = { [LEVEL]: defaultValues };
  
  // 2. Читаем apps.json
  const appsJson = JSON.parse(fs.readFileSync('../apps.json', 'utf8'));
  const appsList = appsJson.apps || [];
  
  // 3. Для каждого app
  for (const app of appsList) {
    // Загружаем db/db.json
    const dbPath = path.resolve(__dirname, `../../apps${app.path}/db/db.json`);
    const appModels = require(dbPath).models;
    allModels = allModels.concat(appModels);
    
    // Загружаем defaultValues.json
    const defaultValuesPath = path.resolve(__dirname, `../../apps${app.path}/db/defaultValues.json`);
    if (fs.existsSync(defaultValuesPath)) {
      const appDefaults = processDefaultValues(require(defaultValuesPath), app.name);
      defaultValuesByLevel[app.name] = appDefaults;
    }
    
    // Собираем динамические данные (systems, access_roles)
    const config = require(`../../apps${app.path}/config.json`);
    // ... добавляем в defaultValuesByLevel[LEVEL]
  }
  
  return { models: allModels, defaultValuesByLevel };
}
```

### 2. Объединение моделей (Merge)

Если одна и та же таблица объявлена на разных уровнях:

```javascript
function mergeModelDefinitions(allDefs) {
  const mergedMap = new Map();
  
  for (const def of allDefs) {
    if (!mergedMap.has(def.name)) {
      mergedMap.set(def.name, JSON.parse(JSON.stringify(def)));
    } else {
      const current = mergedMap.get(def.name);
      // Более поздние определения перезаписывают/расширяют ранние
      current.fields = { ...current.fields, ...def.fields };
      current.options = { ...current.options, ...def.options };
    }
  }
  
  return Array.from(mergedMap.values());
}
```

### 3. Создание таблиц (только в drive_root)

```javascript
// drive_root/db/createDB.js
async function createAll() {
  // 1. Собрать модели
  const { models: allModelsDef, defaultValuesByLevel } = collectAllModels();
  
  // 2. Объединить
  const mergedModelsDef = mergeModelDefinitions(allModelsDef);
  
  // 3. Инициализировать Sequelize модели
  const models = {};
  for (const def of mergedModelsDef) {
    // Конвертировать типы
    // Создать Sequelize модель
  }
  
  // 4. Миграция (если нужна)
  // - Backup data
  // - Drop tables CASCADE
  // - Create new tables
  // - Restore data
  
  // 5. Заполнить defaultValues для ВСЕХ уровней
  for (const [lvlName, lvlValues] of Object.entries(defaultValuesByLevel)) {
    // Обработать defaultValues для уровня lvlName
  }
}
```

### 4. Каскадное заполнение defaultValues

DefaultValues заполняются для каждого уровня отдельно:

```javascript
defaultValuesByLevel = {
  'drive_root': {
    users: [{ id: 1, name: 'admin', ... }],
    sessions: [...]
  },
  'drive_forms': {
    systems: [{ id: 1, name: 'calculator' }, ...],
    access_roles: [{ id: 1, name: 'admin' }, ...]
  },
  'calculator': {
    calculator_settings: [...]
  },
  'fileSystem': {
    FileSystem_Files: [...]
  }
}
```

Для каждого уровня:
1. Собрать все `defaultValueId` из `lvlValues`
2. Удалить записи, которых больше нет в `defaultValues.json`
3. Добавить/обновить записи из `defaultValues.json`
4. Зарегистрировать в таблице `default_values`

---

## Что было исправлено

### ❌ БЫЛО (СЛОМАНО):

1. **drive_root/db/createDB.js:**
   ```javascript
   // НЕПРАВИЛЬНО: напрямую лезет в apps
   const appsDir = path.resolve(__dirname, '../../apps');
   const entries = fs.readdirSync(appsDir);
   
   // НЕПРАВИЛЬНО: запускает drive_forms как отдельный процесс
   const { spawn } = require('child_process');
   const child = spawn(process.execPath, [formsCreateDB]);
   ```

2. **drive_forms/db/createDB.js:**
   ```javascript
   // НЕПРАВИЛЬНО: создает таблицы сам
   await models[def.name].sync({ transaction });
   
   // НЕПРАВИЛЬНО: выполняет миграции
   await sequelize.query(`DROP TABLE ...`);
   ```

3. **Проблемы:**
   - По apps проходятся ДВА РАЗА (в drive_root и в drive_forms)
   - Нарушение архитектуры (drive_root знает про apps)
   - Таблицы drive_forms не создавались
   - Неправильная каскадность

### ✅ СТАЛО (ИСПРАВЛЕНО):

1. **drive_root/db/createDB.js:**
   ```javascript
   // ПРАВИЛЬНО: вызывает функцию
   const formsModule = require('../../drive_forms/db/createDB.js');
   const formsData = formsModule.collectModels();
   
   // ПРАВИЛЬНО: создает ВСЕ таблицы только здесь
   for (const def of mergedModelsDef) {
     await models[def.name].sync({ transaction });
   }
   ```

2. **drive_forms/db/createDB.js:**
   ```javascript
   // ПРАВИЛЬНО: только собирает и возвращает
   function collectModels() {
     // ... сбор моделей ...
     return { models: allModels, defaultValuesByLevel };
   }
   
   module.exports = { collectModels };
   ```

3. **Преимущества:**
   - ✅ Четкое разделение ответственности
   - ✅ Правильная каскадность
   - ✅ По apps проход только ОДИН РАЗ
   - ✅ Все таблицы создаются на drive_root
   - ✅ drive_root не знает про apps напрямую

---

## Точки входа

### Запуск инициализации БД:
```bash
node packages/my-old-space/drive_root/db/createDB.js
```

### Порядок выполнения:
1. `drive_root/db/createDB.js` → `createAll()`
2. → `collectAllModels()`
3. → `drive_forms/db/createDB.js` → `collectModels()`
4. → Сбор из `apps[]/db/db.json`
5. ← Возврат моделей в drive_forms
6. ← Возврат моделей в drive_root
7. `mergeModelDefinitions()`
8. Создание таблиц в БД
9. Миграция (если нужна)
10. Заполнение defaultValues для всех уровней

---

## Файлы, которые были изменены

### ✏️ drive_root/db/createDB.js
- Добавлена функция `collectAllModels()`
- Удален прямой доступ к `../../apps`
- Удален `spawn` для запуска drive_forms
- Изменена логика `createAll()` - теперь вызывает `collectAllModels()`
- Добавлена обработка `defaultValuesByLevel` для всех уровней

### ✏️ drive_forms/db/createDB.js
- Полностью переписан
- Удалены функции создания таблиц
- Удалены миграции
- Добавлена функция `collectModels()` (экспортируется)
- Остались только функции сбора моделей и defaultValues

### ✅ apps/*/db/db.json
- Не изменялись (остались декларативными)

---

## Проверка корректности

### Тесты для проверки:
1. ✅ drive_root НЕ содержит прямых обращений к `../../apps`
2. ✅ drive_root НЕ использует `spawn` или `exec` для drive_forms
3. ✅ drive_forms экспортирует `collectModels`
4. ✅ drive_forms НЕ создает таблицы (нет `sequelize.define` или `sync`)
5. ✅ Все таблицы создаются только в drive_root
6. ✅ defaultValues обрабатываются для всех уровней

### Поиск проблем:
```bash
# Проверка что drive_root не лезет в apps напрямую
grep -n "../../apps" drive_root/db/createDB.js
# Должно быть: НЕТ совпадений

# Проверка что нет spawn
grep -n "spawn\|exec" drive_root/db/createDB.js
# Должно быть: НЕТ совпадений

# Проверка экспорта в drive_forms
grep -n "module.exports" drive_forms/db/createDB.js
# Должно быть: module.exports = { collectModels };
```

---

## Возможные проблемы и решения

### Проблема: Модель объявлена на нескольких уровнях
**Решение:** Функция `mergeModelDefinitions()` объединяет их

### Проблема: defaultValues с одинаковым id на разных уровнях
**Решение:** defaultValues привязаны к уровню через поле `level` в таблице `default_values`

### Проблема: Circular dependency (drive_root ← drive_forms)
**Решение:** drive_forms не требует drive_root для collectModels, только для processDefaultValues (который уже есть)

### Проблема: apps.json не найден
**Решение:** Ловится try-catch, просто не добавляются модели apps

---

## Дальнейшее развитие

### Возможные улучшения:
1. Добавить валидацию моделей перед merge
2. Добавить кеширование собранных моделей
3. Добавить CLI для миграций
4. Добавить dry-run режим
5. Добавить rollback механизм

### НЕ делать:
- ❌ Не добавлять createDB.js в apps (они должны быть декларативными)
- ❌ Не возвращаться к spawn
- ❌ Не давать drive_root прямой доступ к apps
