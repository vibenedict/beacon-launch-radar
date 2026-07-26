/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATAHUB_LIVE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
