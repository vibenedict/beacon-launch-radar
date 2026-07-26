import { createRoot } from 'react-dom/client';
import App from './App';
import './nocturne.css';
import './index.css';

// No StrictMode: the dashboard drives real setInterval timers, and StrictMode's
// double-mount in dev would spin them up twice.
createRoot(document.getElementById('root')!).render(<App />);
