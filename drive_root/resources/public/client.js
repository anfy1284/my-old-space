// function setCookie(name, value) {
//     document.cookie = `$encodeURIComponent(name)}=${encodeURIComponent(value)}`;
// }

// function getCookie(name) {
//     for (let cookie of document.cookie.split('; ')) {
//         let [cookieName, cookieValue] = cookie.split('=');
//         if (cookieName === encodeURIComponent(name)) {
//             return decodeURIComponent(cookieValue);
//         }
//     }
// }

// async function getSessionId() {
//     let clientId = localStorage.getItem('SessionId');
//     if (!clientId) {
//             const response = await fetch('/api', {
//                 method: 'POST',
//                 headers: {
//                     'Content-Type': 'application/json'
//                 },
//                 body: JSON.stringify({ method: 'get_session_id' })
//             });
//             const data = await response.json();
//             clientId = data.sessionId;
//         if (clientId) {
//             localStorage.setItem('sessionId', sessionId);
//         }    
//     }
// }

// async function getClientId() {
//     let clientId = localStorage.getItem('clientId');
//     if (!clientId) {
//         clientId = getCookie('clientId');
//         if (!clientId) {
//             const response = await fetch('/api', {
//                 method: 'POST',
//                 headers: {
//                     'Content-Type': 'application/json'
//                 },
//                 body: JSON.stringify({ method: 'get_client_id' })
//             });
//             const data = await response.json();
//             clientId = data.clientId;
//         }
//     }
//     if (clientId) {
//         localStorage.setItem('clientId', clientId);
//     }
//     return clientId;
// }

// function client_init() {
//     // Здесь можно добавить общую инициализацию ядра (сессия/клиент и т.п.)
//     // Затем запускаем приложение
//     if (window.app && typeof window.app.init === 'function') {
//         window.app.init();
//     }
// }

// // Инициализируем после загрузки DOM
// if (document.readyState === 'loading') {
//     document.addEventListener('DOMContentLoaded', client_init);
// } else {
//     client_init();
// }
