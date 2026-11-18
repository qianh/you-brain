export { MuseAccount, type AccountOptions, type DeviceCredentials, type MuseVM } from "./api.js";
export {
  MuseClient,
  followTurn,
  type ChatOptions,
  type ConnectOptions,
  type MuseHistoryItem,
  type SendOptions,
  type SubscribeOptions,
} from "./client.js";
export {
  NoiseConnection,
  NoiseUpgradeError,
  type MuseResponse,
  type MuseSocketFactory,
  type MuseTransportSocket,
} from "./connection.js";
export {
  externalCredentialsDirectory,
  hasPairingFiles,
  importExternalPairing,
  loadCredentials,
  saveCredentials,
  unpair,
} from "./credentials.js";
export { CipherState, NoiseInitiator } from "./crypto.js";
export { MuseError, MuseHttpError, MuseProtocolError } from "./errors.js";
export { decodeChatEvents, type ChatEvent } from "./events.js";
export {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  chatRequest,
  validateMessage,
  type ImageAttachment,
  type MessageOptions,
} from "./message.js";
export {
  buildPairingHelper,
  pairMacOS,
  validateSDKToken,
  type PairMacOSOptions,
  type PairProgressEvent,
} from "./pairing-macos.js";
export { PairingController } from "./pairing-controller.js";
export {
  PacketAssembler,
  PairingSession,
  encodePackets,
  identityFromMac,
  newIdentity,
  type PairingIdentity,
} from "./pairing-protocol.js";
export {
  MuseTurn,
  ReplayScope,
  acknowledgementIds,
  cleanControlChars,
  transcriptText,
  type AgentStatus,
  type ChatAcknowledgement,
  type Reply,
  type TaskFinished,
  type TurnEvent,
  type TurnOptions,
} from "./turn.js";
