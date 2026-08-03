import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CoworkApp } from './App';
import './styles/theme.css';
import './styles/app.css';

const root = document.getElementById('root');

if (!root) throw new Error('missing root element');

createRoot(root).render(
  <StrictMode>
    <CoworkApp />
  </StrictMode>,
);
