export interface SearchDriveEntry {
  id: string;
  path: string;
  mimeType: string;
}

export interface SearchDriveObject {
  bytes: Uint8Array;
}

export interface SearchDriveChanges {
  entries: SearchDriveEntry[];
  removedIds: string[];
  cursor: string;
  reset: boolean;
}

export interface SearchDrive {
  changes(query: {
    prefix: string;
    cursor?: string;
  }): Promise<SearchDriveChanges>;
  read(id: string): Promise<SearchDriveObject>;
  /** Drive full-text search under `prefix`. Reaches sessions on other devices without downloading them. */
  searchText?(query: { text: string; prefix: string; limit: number }): Promise<SearchDriveEntry[]>;
}
