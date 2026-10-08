/// <reference types="vite/client" />

declare module '*.wgsl?raw' {
  const source: string
  export default source
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
