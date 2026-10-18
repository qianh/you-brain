/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DAEMON_URL?: string;
  readonly VITE_DAEMON_TOKEN?: string;
}

interface TauriNamespace {
  core?: {
    invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

interface YouBrainBootstrap {
  token?: string;
}

declare global {
  interface Window {
    __YOU_BRAIN__?: YouBrainBootstrap;
    __TAURI__?: TauriNamespace;
  }
}

export {};
