// Browser-side Supabase client. Uses the publishable (anon) key — safe to ship
// to the client; Row-Level Security governs what it can read/write.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — auth will not work.');
}

export const supabase = createClient(url, anonKey);
