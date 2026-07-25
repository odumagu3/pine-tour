import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {captureReferralFromUrl} from './referral.js';
import './index.css';

// Runs before the app mounts, so a ?ref= link is banked even though the visitor
// lands on the sign-in gate and won't have an account for another minute.
captureReferralFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
