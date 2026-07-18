import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { VideoApp } from './VideoApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <VideoApp />
  </StrictMode>,
)
