import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');

// Deliberately not wrapped in StrictMode: its double-mount would tear down and
// rebuild the ProseMirror editor instance, dropping the loaded document.
createRoot(container).render(<App />);
