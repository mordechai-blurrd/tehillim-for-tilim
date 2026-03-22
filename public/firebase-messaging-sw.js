// firebase-messaging-sw.js
// Handles background FCM push notifications when the app is not in focus.
// Firebase config is injected at /firebase-config.js (served by server.js).

importScripts('/firebase-config.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

if (self.FIREBASE_CONFIG && self.FIREBASE_CONFIG.projectId) {
  firebase.initializeApp(self.FIREBASE_CONFIG);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage(payload => {
    // Data-only messages: read from payload.data (no payload.notification)
    const title  = payload.data?.title || '🚨 Red Alert — Say Tehillim Now';
    const body   = payload.data?.body  || 'Stop what you are doing and say Tehillim now.';
    const icon   = payload.data?.icon  || `${self.location.origin}/icon-192.png`;
    const link   = payload.data?.link  || self.location.origin;

    self.registration.showNotification(title, {
      body,
      icon,
      badge:              icon,
      requireInteraction: true,
      vibrate:            [300, 100, 300, 100, 300],
      data:               { url: link },
    });
  });
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url === '/' && 'focus' in client) return client.focus();
      }
      return clients.openWindow(event.notification.data?.url || '/');
    })
  );
});
