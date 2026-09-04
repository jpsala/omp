export interface RuntimeProcessResult { exitCode: number; stdout: string; stderr: string }
export interface RuntimeProcessRunOptions { stdin?: string | Uint8Array; timeoutMs?: number; env?: NodeJS.ProcessEnv }
export type RuntimeProcessRunner = (executable: string, argv: readonly string[], options?: RuntimeProcessRunOptions) => Promise<RuntimeProcessResult>;

export interface RuntimeHostLocation {
  instanceRef: string;
  windowId: string;
  tabId: string;
  paneId: string;
  workspace?: string;
  cwd?: string;
}

export interface RuntimeHostSource { instanceRef: string; paneId: string }

export interface RuntimePaneHandle {
  instanceRef: string;
  sourcePaneId: string;
  ownedPaneId: string;
  location: RuntimeHostLocation;
}

export interface RuntimeOpenRequest {
  source: RuntimeHostSource;
  cwd: string;
  program: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeSplitRequest extends RuntimeOpenRequest {
  direction: "left" | "right" | "top" | "bottom";
  percent: number;
}

export type RuntimeTabRequest = RuntimeOpenRequest;
export type RuntimeWindowRequest = RuntimeOpenRequest;

export interface RuntimeHostAdapter {
  split(request: RuntimeSplitRequest): Promise<RuntimePaneHandle>;
  tab(request: RuntimeTabRequest): Promise<RuntimePaneHandle>;
  window(request: RuntimeWindowRequest): Promise<RuntimePaneHandle>;
  finalizeTab(handle: RuntimePaneHandle, title: string, requireAdjacentToSource?: boolean): Promise<void>;
  focus(handle: RuntimePaneHandle): Promise<void>;
  isOwnedPanePresent(handle: RuntimePaneHandle): Promise<boolean>;
  killOwnedPane(handle: RuntimePaneHandle): Promise<void>;
}
