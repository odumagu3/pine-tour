// Loads local env files. Imported FIRST by server.ts so that process.env is
// populated before any other module (e.g. db.ts) reads it at import time.
// In production (Render) these files are absent and env vars come from the
// dashboard, so dotenv is a harmless no-op.
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();
