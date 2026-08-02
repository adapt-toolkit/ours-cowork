import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';

const root = document.getElementById('root');

if (!root) throw new Error('missing root element');

createRoot(root).render(
  <StrictMode>
    <main>Ours Cowork</main>
  </StrictMode>,
);
