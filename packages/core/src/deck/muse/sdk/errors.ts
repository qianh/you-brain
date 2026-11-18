// Adapted from Meta's muse-gadget-sdk and wong2/muse-client (Apache-2.0).

export class MuseError extends Error {
  override name = "MuseError";
}

export class MuseHttpError extends MuseError {
  override name = "MuseHttpError";

  constructor(
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(`Muse ${endpoint} 返回 HTTP ${status}`);
  }
}

export class MuseProtocolError extends MuseError {
  override name = "MuseProtocolError";
}
