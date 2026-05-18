(function () {
  'use strict';

  const LOGIN_URL = 'login.html';

  async function getClient() {
    if (window.supabaseClient) return window.supabaseClient;
    if (window.supabaseReady) return await window.supabaseReady;
    throw new Error('Supabase client not initialized');
  }

  function friendlyError(err) {
    if (!err) return 'Something went wrong. Please try again.';
    const raw = err.message || String(err);
    const msg = raw.toLowerCase();
    if (msg.includes('invalid login credentials')) return 'Invalid email or password.';
    if (msg.includes('email not confirmed')) return 'Please confirm your email before signing in.';
    if (msg.includes('already registered') || msg.includes('user already exists')) return 'An account with that email already exists.';
    if (msg.includes('password should be at least') || msg.includes('password is too short')) return 'Password must be at least 8 characters.';
    if (msg.includes('weak password')) return 'Password is too weak. Try a longer or more complex password.';
    if (msg.includes('unable to validate email') || msg.includes('invalid email')) return 'Please enter a valid email address.';
    if (msg.includes('rate limit') || msg.includes('too many')) return 'Too many attempts. Please wait a moment and try again.';
    if (msg.includes('network') || msg.includes('failed to fetch') || msg.includes('load failed')) return 'Network error. Check your connection and try again.';
    return raw || 'Something went wrong. Please try again.';
  }

  async function signUp(email, password) {
    try {
      const client = await getClient();
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) return { success: false, error: friendlyError(error) };
      return {
        success: true,
        user: data.user,
        session: data.session,
        needsEmailConfirmation: !!(data.user && !data.session),
      };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function signIn(email, password) {
    try {
      const client = await getClient();
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) return { success: false, error: friendlyError(error) };
      return { success: true, user: data.user, session: data.session };
    } catch (err) {
      return { success: false, error: friendlyError(err) };
    }
  }

  async function signOut() {
    try {
      const client = await getClient();
      await client.auth.signOut();
    } catch (err) {
      console.error('Sign out error:', err);
    } finally {
      window.location.href = LOGIN_URL;
    }
  }

  async function getCurrentUser() {
    try {
      const client = await getClient();
      const { data, error } = await client.auth.getUser();
      if (error) return null;
      return data.user || null;
    } catch (err) {
      return null;
    }
  }

  async function requireAuth() {
    const user = await getCurrentUser();
    if (!user) {
      window.location.replace(LOGIN_URL);
      return null;
    }
    return user;
  }

  window.puntoAuth = {
    signUp,
    signIn,
    signOut,
    getCurrentUser,
    requireAuth,
  };
})();
