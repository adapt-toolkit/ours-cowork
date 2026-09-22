import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserSession } from './BrowserSession';
import './styles/theme.css';
import './styles/app.css';

const root = document.getElementById('root');

if (!root) throw new Error('missing root element');

createRoot(root).render(
  <StrictMode>
    <BrowserSession />
  </StrictMode>,
);
