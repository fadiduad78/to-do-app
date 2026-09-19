/* zerotodo sw.js — service worker for PERSISTENT notifications (mobile/PWA).
 *
 * Responsibilities (kept minimal and data-free — it never touches tasks):
 *   • showNotification on behalf of the app (called via
 *     registration.showNotification() directly, but we also accept messages
 *     so a future push path can reuse it);
 *   • route notification CLICKS and ACTIONS back to the app: postMessage to
 *     an open window, or open a new one deep-linked to the task (#t=<id>)
 *     when none exists;
 *   • 'closed' (swiped away) is reported so the app can treat it as
 *     acknowledgement and never re-alert for the same delivery.
 */
'use strict';

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (ev) => {
  const d = ev.data || {};
  if (d.type === 'zt-notify-show') {
    ev.waitUntil(
      self.registration.showNotification(d.title || 'ZeroTodo', {
        body: d.body || '',
        tag: d.tag || undefined,
        data: d.data || {},
        actions: Array.isArray(d.actions) ? d.actions.slice(0, 3) : [],
        requireInteraction: d.persist !== false,
        renotify: false,
      }).catch(() => {})
    );
  }
});

function route(data) {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((list) => {
    const msg = { type: 'zt-notif-action', action: data.__action, data };
    delete msg.data.__action;
    if (list && list.length) {
      const c = list[0];
      try { c.postMessage(msg); } catch (_) {}
      if (c.focus) return c.focus();
      return undefined;
    }
    // No open window: deep-link a fresh one straight to the task so the
    // click still "opens the corresponding task" (spec) even on mobile.
    const hash = data.taskId ? '#t=' + encodeURIComponent(data.taskId)
      : data.projectId ? '#p=' + encodeURIComponent(data.projectId) : '';
    return self.clients.openWindow(self.registration.scope + hash).then((cl) => {
      // the new client loads asynchronously; it reads the hash at boot
      if (cl && cl.postMessage) { setTimeout(() => { try { cl.postMessage(msg); } catch (_) {} }, 1200); }
      return cl;
    });
  });
}

self.addEventListener('notificationclick', (ev) => {
  const data = (ev.notification && ev.notification.data) || {};
  const action = ev.action || 'open';
  ev.notification.close();
  ev.waitUntil(route(Object.assign({}, data, { __action: action })));
});

self.addEventListener('notificationclose', (ev) => {
  const data = (ev.notification && ev.notification.data) || {};
  ev.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((list) => {
      (list || []).forEach((c) => {
        try { c.postMessage({ type: 'zt-notif-action', action: 'closed', data }); } catch (_) {}
      });
      return undefined;
    })
  );
});
