export type NodeType = 'terminal' | 'note' | 'portal' | 'band' | 'drawing' | 'device';

export interface TerminalData {
  name: string;
  command: string;
  cwd: string;
  agentType: AgentType;
  presetId?: string;
  roleId?: string;
  color: string;
  icon?: string;
  chat: boolean;
  maestro?: boolean;
  ombro?: boolean;
}

export interface NoteData {
  name: string;
  color: string;
  locked: boolean;
  stack?: string;
  preview: boolean;
}

export interface PortalData {
  name: string;
  url: string;
  viewport: { width: number; height: number };
  ua?: 'desktop' | 'ios' | 'android';
}

export interface DeviceData {
  name: string;
  platform: 'android' | 'ios';
  deviceId?: string;
}

export interface BandData {
  name: string;
  members: string[];
  color: string;
  icon?: string;
}

export interface DrawingData {
  kind: 'pen' | 'arrow' | 'rect' | 'ellipse' | 'text';
  points: [number, number][];
  color: string;
  width: number;
  text?: string;
}

export interface PalcoNode<T = unknown> {
  id: string;
  type: NodeType;
  floorId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  data: T;
  createdAt: string;
}

export interface Edge {
  id: string;
  a: string;
  b: string;
  createdAt: string;
}

export type FloorState = 'working' | 'blocked' | 'review' | 'done';

export interface Floor {
  id: string;
  name: string;
  dir: string;
  ground: boolean;
  git: boolean;
  branch?: string;
  baseBranch?: string;
  unloaded?: boolean;
  status?: { text: string; state?: FloorState; progress?: string; updatedAt: string };
  createdAt: string;
}

export type AgentType = 'claude_code' | 'codex' | 'opencode' | 'gemini' | 'shell' | 'custom';

export interface Preset {
  id: string;
  name: string;
  command: string;
  agentType: AgentType;
  chat: boolean;
  quickStart: boolean;
  maestro: boolean;
  color: string;
}

export interface Role {
  id: string;
  name: string;
  prompt: string;
  scope: 'global' | 'workspace';
}

export interface RoutineSchedule {
  cron?: string;
  every?: string;
  at?: string;
  once?: string;
}

export interface Routine {
  id: string;
  name: string;
  kind: 'command' | 'prompt' | 'reminder';
  target?: string;
  command: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  skipIfBusy: boolean;
  lastRunAt?: string;
  lastResult?: string;
}

export interface PartituraItem {
  ref: string;
  type: NodeType;
  dx: number;
  dy: number;
  w: number;
  h: number;
  data: unknown;
  note?: string;
}

export interface Partitura {
  id: string;
  name: string;
  items: PartituraItem[];
  edges: [string, string][];
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  dir: string;
  createdAt: string;
  lastOpenedAt: string;
  floors: Floor[];
  nodes: PalcoNode[];
  edges: Edge[];
  viewport: Record<string, { x: number; y: number; zoom: number }>;
  roles: Role[];
  routines: Routine[];
  unloaded?: boolean;
}

export interface Config {
  version: 1;
  token: string;
  port: number;
  presets: Preset[];
  roles: Role[];
  partituras: Partitura[];
  workspaceOrder: string[];
  settings: {
    idleMs: number;
    terminalFontSize: number;
    theme: 'system' | 'dark' | 'light';
    notifications: boolean;
    ombro?: boolean;
  };
}

export interface ChatEntry {
  id: string;
  ts: string;
  from: 'user' | 'agent' | 'peer' | 'system';
  name?: string;
  text: string;
  attachments?: string[];
}
