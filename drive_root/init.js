// Level initialization. Use this space for code that should run during system startup at the base level.
// console.log('drive_root/init.js executed');

// Initialize dbGateway (root-level middleware registration point)
require('./dbGateway');
console.log('[drive_root/init] dbGateway initialized');
