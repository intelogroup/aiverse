export interface RosterEntry {
  name: string;
  isNative: boolean;
  status: string;
}

export type RosterMap = Record<string, RosterEntry>;
