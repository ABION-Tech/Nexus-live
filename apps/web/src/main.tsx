import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/tokens.css';
import './styles/components.css';
import './styles/patterns.css';
import './modules/dashboard/dashboard.css';
import './modules/network/network.css';
import './modules/work/calendar.css';
import './modules/people/people.css';
import './components/navigation/navigation.css';
import { App } from './app/App';
import { registerServiceWorker } from './utils/registerServiceWorker';

registerServiceWorker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
