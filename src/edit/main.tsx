import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { EditApp } from './EditApp'
import { bootCloud } from '../lib/cloud'
import { CloudBanner } from '../components/cloud/CloudBanner'

// Cloud deployment: load the synced settings before the app reads them
void bootCloud().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <EditApp />
      <CloudBanner pill />
    </StrictMode>,
  )
})
