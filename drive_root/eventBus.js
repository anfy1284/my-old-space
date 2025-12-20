// Простой асинхронный EventBus для Node.js (глобальный уровень)
const events = {};

module.exports = {
  on(event, handler) {
    if (!events[event]) events[event] = [];
    events[event].push(handler);
  },

  async emit(event, ...args) {
    if (events[event]) {
      for (const handler of events[event]) {
        await handler(...args);
      }
    }
  },

  clear() {
    Object.keys(events).forEach(e => delete events[e]);
  }
};
