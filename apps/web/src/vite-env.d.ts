/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API's address when it's deployed on a different site. Leave unset in development. */
  readonly VITE_API_URL?: string
}
