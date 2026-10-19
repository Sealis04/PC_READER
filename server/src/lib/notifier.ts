// In-process wakeups for the events streams. The database is the source of truth for pending
// requests; a notification only tells an open stream to look again. One server instance is
// assumed (see the M3 plan). State lives on globalThis because Next may bundle the route
// handlers and the dashboard actions separately.
type Listener = () => void;

interface Connection {
  id: string;
  close: () => void;
}

interface NotifierState {
  listeners: Map<string, Set<Listener>>;
  connections: Map<string, Connection>;
}

const g = globalThis as unknown as { __pcreaderNotifier?: NotifierState };
const state: NotifierState = (g.__pcreaderNotifier ??= { listeners: new Map(), connections: new Map() });

export function subscribe(deviceId: string, listener: Listener): () => void {
  let set = state.listeners.get(deviceId);
  if (!set) state.listeners.set(deviceId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) state.listeners.delete(deviceId);
  };
}

export function notifyDevice(deviceId: string): void {
  for (const listener of state.listeners.get(deviceId) ?? []) listener();
}

// Registers the device's live stream and closes the one it replaces (a half-open connection
// the server has not noticed yet). Returns a function that forgets this stream.
export function registerConnection(deviceId: string, conn: Connection): () => void {
  state.connections.get(deviceId)?.close();
  state.connections.set(deviceId, conn);
  return () => {
    if (state.connections.get(deviceId)?.id === conn.id) state.connections.delete(deviceId);
  };
}
