// Simple async EventBus for Node.js
const events = {};

module.exports = {
  /**
   * Subscribe to event
   * @param {string} event - event name
   * @param {function} handler - async handler function
   */
  on(event, handler) {
    if (!events[event]) events[event] = [];
    events[event].push(handler);
  },

  /**
   * Call all event handlers
   * @param {string} event - event name
   * @param  {...any} args - arguments for handlers
   */
  async emit(event, ...args) {
    if (events[event]) {
      for (const handler of events[event]) {
        await handler(...args);
      }
    }
  },

  /**
   * Reset all handlers (for tests or restart)
   */
  clear() {
    Object.keys(events).forEach(e => delete events[e]);
  }
};
