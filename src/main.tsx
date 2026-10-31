import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, loadTheme } from './lib/theme'
import { bootCloud } from './lib/cloud'
import { CloudBanner } from './components/cloud/CloudBanner'

// Before anything renders so the page never flashes the wrong palette
applyTheme(loadTheme())

// On the cloud deployment, pull the synced settings first so the app starts
// with them; opened as a local file this resolves immediately
void bootCloud().then(() => {
  applyTheme(loadTheme())
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      <CloudBanner />
    </StrictMode>,
  )
})
