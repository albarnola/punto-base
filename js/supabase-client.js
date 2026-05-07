(function () {
  'use strict';

  const SUPABASE_URL = 'https://szrrkukunnfybqivcwlq.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6cnJrdWt1bm5meWJxaXZjd2xxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMDIyODgsImV4cCI6MjA5MzY3ODI4OH0.2HiDuSLfbA8qUsPbfwdWV9M2MwN4_BXuc3OsvwPT-eU';

  let resolveReady;
  let rejectReady;
  window.supabaseReady = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function tryInit() {
    if (window.supabaseClient) return true;
    const sdk = window.supabase;
    if (!sdk || typeof sdk.createClient !== 'function') return false;
    window.supabaseClient = sdk.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    resolveReady(window.supabaseClient);
    return true;
  }

  if (tryInit()) return;

  const POLL_MS = 25;
  const TIMEOUT_MS = 10000;
  const start = Date.now();
  const interval = setInterval(() => {
    if (tryInit()) {
      clearInterval(interval);
    } else if (Date.now() - start > TIMEOUT_MS) {
      clearInterval(interval);
      rejectReady(new Error('Supabase SDK failed to load within ' + TIMEOUT_MS + 'ms'));
    }
  }, POLL_MS);
})();
