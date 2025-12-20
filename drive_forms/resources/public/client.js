/**
 * Call application server method
 * @param {string} app - application name (e.g. 'login')
 * @param {string} method - method name
 * @param {object} params - parameters (object)
 * @returns {Promise<object>} - result of the call
 */
function callServerMethod(app, method, params = {}) {
	return fetch('/app/call', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ app, method, params })
	})
		.then(r => r.json())
		.then(data => {
			if ('error' in data) throw new Error(data.error);
			return data.result;
		});
}
