export type MuseConnectionState = "unpaired" | "idle" | "connecting" | "connected" | "error";

export type MusePairingPhase =
  | "idle"
  | "compiling"
  | "advertising"
  | "connected"
  | "verifying"
  | "error";

export interface DeckMusePairingView {
  state: MusePairingPhase;
  deviceName?: string | undefined;
  message?: string | undefined;
  error?: string | undefined;
}

export interface DeckMuseVmView {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface DeckMuseImageView {
  filename: string;
  mimeType: string;
  /** Compact data URL kept locally so user-sent screenshots remain visible in the thread. */
  dataUrl?: string | undefined;
}

export interface DeckMuseMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  done: boolean;
  /** "app" when synced from the user's phone/desktop Muse App on Main Chat. */
  origin?: "local" | "app" | undefined;
  error?: string | undefined;
  images?: DeckMuseImageView[] | undefined;
}

export interface DeckMuseSessionSummary {
  id: string;
  kind: "main" | "side";
  title: string;
  updatedAt: string;
  preview: string;
  messageCount: number;
  busy: boolean;
  activityText?: string | undefined;
}

export interface DeckMuseSessionDetail {
  id: string;
  kind: "main" | "side";
  title: string;
  updatedAt: string;
  busy: boolean;
  activityText?: string | undefined;
  error?: string | undefined;
  messages: DeckMuseMessage[];
}

export interface DeckMuseOverview {
  paired: boolean;
  /** Direct BLE peripheral pairing requires macOS. */
  platformSupported: boolean;
  /** True when ~/Library/Application Support/MuseGadgetPair already holds credentials. */
  hasExternalPairing: boolean;
  deviceId: string | null;
  sdkTokenHint: string | null;
  warning: string | null;
  connection: MuseConnectionState;
  connectionError: string | null;
  selectedVmId: string | null;
  vm: { id: string; name: string } | null;
  vms: DeckMuseVmView[];
  pairing: DeckMusePairingView;
  sessions: DeckMuseSessionSummary[];
}

export type DeckMuseActionInput =
  | { action: "pair-start"; sdkToken?: string | undefined; probe?: boolean | undefined }
  | { action: "pair-cancel" }
  | { action: "pair-import" }
  | { action: "unpair" }
  | { action: "reconnect" }
  | { action: "select-vm"; vmId: string | null }
  | { action: "session-create"; title?: string | undefined }
  | { action: "session-rename"; id: string; title: string }
  | { action: "session-delete"; id: string }
  | { action: "turn-cancel"; sessionId: string };

export interface DeckMuseActionResult {
  overview: DeckMuseOverview;
  createdSessionId?: string | undefined;
  session?: DeckMuseSessionDetail | undefined;
}

export interface DeckMuseSendImageInput {
  filename: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  dataBase64: string;
}

export interface DeckMuseSendInput {
  sessionId: string;
  text: string;
  images?: DeckMuseSendImageInput[] | undefined;
}

export interface DeckMuseSendResult {
  overview: DeckMuseOverview;
  session: DeckMuseSessionDetail;
}

export type DeckMuseStreamEvent =
  | { type: "overview"; overview: DeckMuseOverview }
  | { type: "session"; session: DeckMuseSessionDetail };
