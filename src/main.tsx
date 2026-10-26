import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';
import { AppStoreProvider } from './core/store.js';
import { registerAllModules } from './modules/index.js';
import 'katex/dist/katex.min.css';
import './app/styles.css';

registerAllModules();

const container = document.getElementById('root');
if (container === null) throw new Error('#root missing');

createRoot(container).render(
  <React.StrictMode>
    <AppStoreProvider>
      <App />
    </AppStoreProvider>
  </React.StrictMode>,
);