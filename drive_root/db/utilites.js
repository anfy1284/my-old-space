const bcrypt = require('bcrypt');
const crypto = require('crypto');

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function validatePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Creates a unique identifier based on the custom algorithm:
 * Group 1: Time in ms (9 chars)
 * Group 2: Hash of input string (7 chars)
 * Group 3: Random value (7 chars)
 */
function generateUID(inputString = '') {
  // Group 1: Time (9 chars base36)
  const timeStr = Date.now().toString(36).padStart(9, '0').slice(-9);

  // Group 2: Hash of string (7 chars base36)
  let hashStr = '0000000';
  if (inputString && typeof inputString === 'string') {
    const hashHex = crypto.createHash('md5').update(inputString).digest('hex');
    hashStr = parseInt(hashHex.substring(0, 10), 16).toString(36).padStart(7, '0').slice(-7);
  }

  // Group 3: Random (7 chars base36)
  const randStr = crypto.randomBytes(6).readUIntBE(0, 6).toString(36).padStart(7, '0').slice(-7);

  return `${timeStr}-${hashStr}-${randStr}`;
}

module.exports = {
  hashPassword,
  validatePassword,
  generateUID,
};
