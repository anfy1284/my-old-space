// Утилиты для миграций БД

/**
 * Нормализует тип поля из describeTable для сравнения с определениями Sequelize.
 * Приводится к единому ключу, понятному Sequelize.
 * @param {string} t - Тип поля из БД
 * @param {string} dialect - Диалект БД (postgres, sqlite)
 * @returns {string} - Нормализованный тип (например, "STRING")
 */
/**
 * Привести тип к сопоставимому виду.
 * @param {string} t       — тип (из описания колонки БД или из определения модели)
 * @param {string} dialect — 'postgres' | 'sqlite'
 * @param {string} origin  — 'db' (описание колонки, по умолчанию) | 'model'
 *                           Нужен из-за слова «DATE»: в модели это момент
 *                           времени, в postgres — календарная дата.
 */
function normalizeType(t, dialect = 'postgres', origin = 'db') {
  if (!t) return '';
  const s = String(t).toUpperCase();

  if (dialect === 'sqlite') {
    if (s.includes('VARCHAR') || s.includes('STRING') || s.includes('TEXT')) return 'STRING';
    if (s.includes('INT')) return 'INTEGER';
    if (s.includes('BOOL')) return 'BOOLEAN';
    if (s.includes('DATE') || s.includes('TIME')) return 'DATE';
    if (s.includes('REAL') || s.includes('FLOAT') || s.includes('DOUBLE')) return 'FLOAT';
    return s;
  }

  // Postgres types
  if (s.includes('CHARACTER VARYING') || s.includes('VARCHAR')) return 'STRING';
  if (s === 'TEXT') return 'TEXT';
  if (s === 'INTEGER' || s === 'INT4' || s === 'INT') return 'INTEGER';
  if (s === 'BIGINT' || s === 'INT8') return 'BIGINT';
  if (s === 'SMALLINT' || s === 'INT2') return 'SMALLINT';
  if (s === 'BOOLEAN' || s === 'BOOL') return 'BOOLEAN';

  // Даты: календарная дата и момент времени — РАЗНЫЕ типы, схлопывать их
  // в один нельзя (иначе настоящая смена типа пройдёт незамеченной).
  //   Sequelize DATEONLY ←→ postgres `date`
  //   Sequelize DATE     ←→ postgres `timestamp with time zone`
  //
  // ВНИМАНИЕ: слово «DATE» означает РАЗНОЕ с двух сторон — в определении
  // модели это момент времени, в описании колонки postgres это календарная
  // дата. Поэтому нормализация обязана знать источник типа; без этого
  // сравнение либо путает типы, либо считает совпадающие поля разными.
  if (origin === 'model') {
    if (s === 'DATEONLY') return 'DATEONLY';
    if (s === 'DATE' || s === 'DATETIME') return 'DATE';
  } else {
    if (s === 'DATE') return 'DATEONLY';
    if (s.includes('TIMESTAMP') || s === 'DATETIME') return 'DATE';
  }

  // Числа с плавающей точкой: Sequelize FLOAT в postgres — это
  // `double precision`. Без этой пары сравнение схем считало поле
  // изменившимся ВСЕГДА.
  if (s === 'FLOAT' || s === 'FLOAT8' || s === 'FLOAT4' || s === 'REAL' || s.includes('DOUBLE')) return 'FLOAT';
  // DECIMAL/NUMERIC — отдельный тип (деньги), с FLOAT не смешивать.
  if (s === 'DECIMAL' || s === 'NUMERIC') return 'DECIMAL';

  if (s.includes('JSON')) return 'JSON';

  return s;
}

async function compareSchemas(currentSchema, desiredSchema, dialect = 'postgres') {
  const Sequelize = require('sequelize');
  let needsMigration = false;
  const differences = [];
  const commonFields = [];

  for (const [fieldName, fieldDef] of Object.entries(desiredSchema)) {
    if (!currentSchema[fieldName]) {
      differences.push(`+ Добавлено поле: ${fieldName}`);
      needsMigration = true;
    } else {
      const dbCol = currentSchema[fieldName];

      // 1. Проверка типа
      const currentTypeNorm = normalizeType(dbCol.type, dialect);
      // Желаемый тип ОБЯЗАН проходить через ту же нормализацию, что и тип из
      // базы. Раньше он брался как есть, и `DATEONLY` (модель) сравнивался с
      // `DATE` (колонка postgres) как разные типы, а `FLOAT` — с
      // `DOUBLE PRECISION`. Итог: 12 таблиц считались изменившимися при
      // КАЖДОМ старте сервера и каждый раз дропались с восстановлением из
      // временной копии. Именно эта перестройка и обнуляла представления
      // записей и отметки времени.
      const desiredTypeNorm = normalizeType(
        (Sequelize.DataTypes[fieldDef.type] && Sequelize.DataTypes[fieldDef.type].key) || fieldDef.type,
        dialect,
        'model'
      );

      let desiredAllowNull = fieldDef.allowNull === undefined ? true : !!fieldDef.allowNull;
      if (fieldDef.primaryKey) desiredAllowNull = false;
      const currentAllowNull = !!dbCol.allowNull;

      const desiredPK = !!fieldDef.primaryKey;
      const currentPK = !!dbCol.primaryKey;

      const isTypeDiff = currentTypeNorm !== desiredTypeNorm;
      const isNullDiff = currentAllowNull !== desiredAllowNull;
      const isPKDiff = currentPK !== desiredPK;

      if (isTypeDiff || isNullDiff || isPKDiff) {
        console.log(`[MIGRATION] Comparison for field ${fieldName}:`);
        console.log(`  Current (DB): type=${dbCol.type} (norm: ${currentTypeNorm}), allowNull=${currentAllowNull}, PK=${currentPK}`);
        console.log(`  Desired (MD): type=${fieldDef.type} (norm: ${desiredTypeNorm}), allowNull=${desiredAllowNull}, PK=${desiredPK}`);

        if (isTypeDiff) {
          differences.push(`~ Изменен тип поля ${fieldName}: ${dbCol.type} (норм: ${currentTypeNorm}) -> ${desiredTypeNorm}`);
          needsMigration = true;
        }

        if (isNullDiff) {
          differences.push(`~ Изменено свойство allowNull ${fieldName}: ${currentAllowNull} -> ${desiredAllowNull}`);
          needsMigration = true;
        }

        if (isPKDiff) {
          differences.push(`~ Изменен статус primaryKey ${fieldName}: ${currentPK} -> ${desiredPK}`);
          needsMigration = true;
        }
      }

      commonFields.push(fieldName);
    }
  }

  for (const fieldName of Object.keys(currentSchema)) {
    if (!desiredSchema[fieldName] && !['createdAt', 'updatedAt'].includes(fieldName)) {
      differences.push(`- Удалено поле: ${fieldName}`);
      needsMigration = true;
    }
  }

  return { needsMigration, differences, commonFields };
}

async function syncUniqueConstraints(sequelize, transaction, tableName, desiredSchema) {
  const dialect = sequelize.getDialect();
  if (dialect !== 'postgres') {
    // SQLite handles unique constraints through indexes or table recreation, 
    // and our migration strategy already handles table recreation.
    return;
  }

  try {
    const uniqueConstraints = await sequelize.query(
      `SELECT c.conname, string_agg(a.attname, ',') AS cols
           FROM pg_constraint c
           JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a ON a.attnum = k.attnum AND a.attrelid = c.conrelid
           WHERE c.conrelid = '"${tableName}"'::regclass AND c.contype = 'u'
           GROUP BY c.conname`,
      { transaction, type: require('sequelize').QueryTypes.SELECT }
    );

    for (const uc of uniqueConstraints) {
      const cols = (uc.cols || '').split(',').map(s => s.trim()).filter(Boolean);
      const allColsStillUnique = cols.every(col => desiredSchema[col] && desiredSchema[col].unique);
      if (!allColsStillUnique) {
        await sequelize.query(`ALTER TABLE "${tableName}" DROP CONSTRAINT "${uc.conname}"`, { transaction });
        console.log(`[MIGRATION] Dropped unique constraint ${uc.conname} on ${tableName} (${cols.join(',')})`);
      }
    }
  } catch (err) {
    console.error(`[MIGRATION] Не удалось обработать уникальные ограничения для ${tableName}:`, err.message || err);
  }
}

module.exports = {
  normalizeType,
  compareSchemas,
  syncUniqueConstraints
};
