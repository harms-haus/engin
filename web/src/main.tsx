import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'virtual:engin-renderers'; // auto-discovers workflow renderers via Vite plugin
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
