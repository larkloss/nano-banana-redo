// Light/dark switch for the generator page. Stored per browser; the class on
// <html> re-points the palette variables defined in index.css.
export type Theme = 'light' | 'dark'

const THEME_KEY = 'nbr.theme'

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('theme-light', theme === 'light')
  root.classList.toggle('theme-dark', theme === 'dark')
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // storage unavailable — the choice just won't persist
  }
}
