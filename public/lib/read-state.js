/* SPEC-005: Read / Unread — localStorage-backed read state */
(function () {
  'use strict';
  const KEY = 'rss_read_articles';

  function getReadArticles() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      return {};
    }
  }

  function isRead(guid) {
    return guid in getReadArticles();
  }

  function markAsRead(guid) {
    const read = getReadArticles();
    if (read[guid]) return;
    read[guid] = new Date().toISOString();
    localStorage.setItem(KEY, JSON.stringify(read));
  }

  function markAsUnread(guid) {
    const read = getReadArticles();
    delete read[guid];
    localStorage.setItem(KEY, JSON.stringify(read));
  }

  function toggleRead(guid) {
    if (isRead(guid)) {
      markAsUnread(guid);
    } else {
      markAsRead(guid);
    }
    return isRead(guid);
  }

  function markMultipleAsRead(guids) {
    const read = getReadArticles();
    const now = new Date().toISOString();
    guids.forEach(function (guid) {
      if (!read[guid]) read[guid] = now;
    });
    localStorage.setItem(KEY, JSON.stringify(read));
  }

  // Only prune marks for articles no longer served by any feed. Pruning by age
  // alone resurrected old posts as unread in slow feeds that keep serving them.
  function cleanupReadArticles(maxAge, liveGuids) {
    if (maxAge == null) maxAge = 30;
    const live = liveGuids instanceof Set ? liveGuids : new Set(liveGuids || []);
    const read = getReadArticles();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAge);
    const cutoffISO = cutoff.toISOString();
    let changed = false;
    for (const guid in read) {
      if (read[guid] < cutoffISO && !live.has(guid)) {
        delete read[guid];
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem(KEY, JSON.stringify(read));
    }
  }

  window.RSS_READ_STATE = {
    getReadArticles: getReadArticles,
    isRead: isRead,
    markAsRead: markAsRead,
    markAsUnread: markAsUnread,
    toggleRead: toggleRead,
    markMultipleAsRead: markMultipleAsRead,
    cleanupReadArticles: cleanupReadArticles
  };
})();
