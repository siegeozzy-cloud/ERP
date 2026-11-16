// Follow the system's light or dark setting before the first paint, so there's no flash.
// A file rather than an inline script, so the Content-Security-Policy can allow scripts from this site only.
;(() => {
  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = () => document.documentElement.classList.toggle('dark', dark.matches)
  apply()
  dark.addEventListener('change', apply)
})()
