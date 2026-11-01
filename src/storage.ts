// Device-only storage. IndexedDB holds a random per-device salt and encrypted
// profiles filed under an id derived from the save code. Nothing readable is stored.

import { deriveKeys, fromB64, open, randomSalt, seal, toB64, KDF, type Keys, type Sealed } from './crypto';
import type { Profile } from './model';

export interface StoredProfile extends Sealed {
  id: string;
  updatedAt: string;
}

/** Small interface so a hosted store could be added later without touching the app. */
export interface Store {
  get(id: string): Promise<StoredProfile | undefined>;
  put(rec: StoredProfile): Promise<void>;
  remove(id: string): Promise<void>;
  salt(): Promise<Uint8Array>;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export class DeviceStore implements Store {
  private db?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((res, rej) => {
      const r = indexedDB.open('watchbill-organizer', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meta');
        r.result.createObjectStore('profiles', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  }

  private async tx(store: string, mode: IDBTransactionMode = 'readonly') {
    return (await this.open()).transaction(store, mode).objectStore(store);
  }

  async get(id: string) {
    return req<StoredProfile | undefined>((await this.tx('profiles')).get(id));
  }
  async put(rec: StoredProfile) {
    await req((await this.tx('profiles', 'readwrite')).put(rec));
  }
  async remove(id: string) {
    await req((await this.tx('profiles', 'readwrite')).delete(id));
  }
  async salt() {
    const meta = await this.tx('meta', 'readwrite');
    const s = await req<string | undefined>(meta.get('salt'));
    if (s) return fromB64(s);
    const fresh = randomSalt();
    await req((await this.tx('meta', 'readwrite')).put(toB64(fresh), 'salt'));
    return fresh;
  }
}

export async function unlock(store: Store, code: string): Promise<{ keys: Keys; profile: Profile } | null> {
  const keys = await deriveKeys(code, await store.salt());
  const rec = await store.get(keys.id);
  if (!rec) return null;
  try {
    return { keys, profile: await open<Profile>(keys.key, rec) };
  } catch {
    return null;
  }
}

export async function save(store: Store, keys: Keys, profile: Profile): Promise<void> {
  const sealed = await seal(keys.key, profile);
  await store.put({ id: keys.id, updatedAt: new Date().toISOString(), ...sealed });
}

// ---------- backup files ----------

export interface BackupFile extends Sealed {
  format: 'watchbill-organizer-backup';
  version: 1;
  kdf: typeof KDF;
  salt: string;
  savedAt: string;
}

/** The backup is encrypted the same way; it needs the save code to open. */
export async function makeBackup(code: string, profile: Profile): Promise<BackupFile> {
  const salt = randomSalt();
  const { key } = await deriveKeys(code, salt);
  return {
    format: 'watchbill-organizer-backup',
    version: 1,
    kdf: KDF,
    salt: toB64(salt),
    savedAt: new Date().toISOString(),
    ...(await seal(key, profile)),
  };
}

export async function readBackup(file: BackupFile, code: string): Promise<Profile | null> {
  if (file?.format !== 'watchbill-organizer-backup') return null;
  try {
    const { key } = await deriveKeys(code, fromB64(file.salt));
    return await open<Profile>(key, file);
  } catch {
    return null;
  }
}

export async function askPersistent(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
