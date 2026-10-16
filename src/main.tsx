import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './ServerApp';
import './style.css';
import './workspace.css';
import './jobs-v14.css';
import './content-v14-1.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
