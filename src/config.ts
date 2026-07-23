// Frontend runtime config. In Option B the frontend (Vercel) and backend
// (Render) are separate origins, so API/WS base URLs come from env vars.
// When they are empty (e.g. the local monolith), we fall back to same-origin.

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

// Build an absolute (or same-origin relative) URL for a REST endpoint.
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

// Build the WebSocket URL, appending the given query string (leading '?').
export function wsUrl(query: string): string {
  const configured = (import.meta.env.VITE_WS_URL || '').replace(/\/+$/, '');
  if (configured) return `${configured}${query}`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${query}`;
}
