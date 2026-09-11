/* ==========================================================
 * sw.js —— Service Worker（PWA 离线缓存）
 * 策略：
 *   - 本地文件：缓存优先 + 后台更新（stale-while-revalidate）
 *   - 页面导航：网络优先，离线时回退缓存
 *   - 跨域请求（LLM API）：始终直连网络，不做缓存
 * 更新版本号（VERSION）即可让客户端刷新缓存
 * ========================================================== */
'use strict';

var VERSION = 'v1.7.0';
var CACHE = 'goalflow-' + VERSION;

var ASSETS = [
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/store.js',
  './js/rules.js',
  './js/aggregate.js',
  './js/ai.js',
  './js/adjust.js',
  './js/chart.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 逐个缓存，单个失败不阻断安装
      return Promise.allSettled(ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' }));
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k !== CACHE ? caches.delete(k) : null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // 跨域（AI API 请求等）直接走网络，不拦截不缓存
  if (url.origin !== location.origin) return;

  // 页面导航：网络优先，离线回退缓存
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return resp;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  event.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req).then(function (resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return resp;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
