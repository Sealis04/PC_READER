const TIME_ZONE = process.env.DISPLAY_TIMEZONE || "Asia/Manila";

const dateTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDateTime(value: Date | null | undefined): string {
  return value ? dateTime.format(value) : "Never";
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const OS_LABEL = { windows: "Windows", macos: "macOS" } as const;

export const STATUS_LABEL = {
  in_use: "In use",
  spare: "Spare",
  under_repair: "Under repair",
  for_disposal: "For disposal",
  disposed: "Disposed",
  lost: "Lost",
} as const;

export const CATEGORY_LABEL = {
  cpu: "CPU",
  ram: "Memory",
  storage: "Storage",
  motherboard: "Motherboard",
  gpu: "Graphics",
  nic: "Network adapter",
  psu: "Power supply",
} as const;

export const STALE_MS = 48 * 60 * 60 * 1000;

export function isStale(lastSeenAt: Date | null, now = new Date()): boolean {
  return !lastSeenAt || now.getTime() - lastSeenAt.getTime() > STALE_MS;
}

export type ConnectionState = "online" | "offline" | "stale";

// Online while the agent's events stream is open; Stale once it has been offline for over 48 hours
// (or was never seen); Offline otherwise.
export function connectionState(d: { online: boolean; lastSeenAt: Date | null }, now = new Date()): ConnectionState {
  if (d.online) return "online";
  return isStale(d.lastSeenAt, now) ? "stale" : "offline";
}

export const CONNECTION_LABEL = { online: "Online", offline: "Offline", stale: "Stale" } as const;

export const REQUEST_LABEL = {
  scan_now: "Scan now",
  send_logs: "Send logs",
  prompt_details_update: "Ask user to confirm details",
} as const;

export const REQUEST_STATUS_LABEL = {
  pending: "Waiting for the PC",
  delivered: "Sent to the PC",
  done: "Done",
  failed: "Failed",
} as const;

export const CONNECTION_TYPE_LABEL = { ethernet: "Ethernet", wifi: "Wi-Fi", other: "Other" } as const;
