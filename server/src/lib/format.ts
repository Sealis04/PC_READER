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

const STALE_MS = 48 * 60 * 60 * 1000;

export function isStale(lastSeenAt: Date | null, now = new Date()): boolean {
  return !lastSeenAt || now.getTime() - lastSeenAt.getTime() > STALE_MS;
}
