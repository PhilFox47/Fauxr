import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const canUseServiceWorker =
  location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

if ('serviceWorker' in navigator && canUseServiceWorker) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* installability is a nice-to-have, never a blocker */
    });
  });
}
