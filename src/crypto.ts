// Everything saved is encrypted with a key derived from the save code.
// The code itself is never stored, so the saved data is unreadable without it.
//
// master = Argon2id(code, salt)   (slow on purpose: every wrong guess costs ~1 s)
// id     = HKDF(master, "id")     (where the profile is filed; reveals nothing)
// key    = HKDF(master, "enc")    (AES-GCM, fresh random IV on every save)

import { argon2id } from 'hash-wasm';

export const KDF = { alg: 'argon2id', memorySize: 65536, iterations: 3, parallelism: 1 } as const;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to misread

export interface Sealed {
  iv: string;
  ct: string;
}

export interface Keys {
  id: string;
  key: CryptoKey;
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 16 characters, about 80 bits, shown as ABCD-EFGH-JKLM-NPQR. */
export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const raw = Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
  return raw.match(/.{4}/g)!.join('-');
}

export function isValidCode(code: string): boolean {
  const n = normalizeCode(code);
  return n.length === 16 && [...n].every((c) => ALPHABET.includes(c));
}

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export async function deriveKeys(code: string, salt: Uint8Array): Promise<Keys> {
  const master = await argon2id({
    password: normalizeCode(code),
    salt,
    parallelism: KDF.parallelism,
    iterations: KDF.iterations,
    memorySize: KDF.memorySize,
    hashLength: 32,
    outputType: 'binary',
  });
  const hkdf = await crypto.subtle.importKey('raw', master as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (info: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: new TextEncoder().encode(info),
  });
  const idBits = await crypto.subtle.deriveBits(params('watchbill-id'), hkdf, 256);
  const key = await crypto.subtle.deriveKey(params('watchbill-enc'), hkdf, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  return { id: toHex(new Uint8Array(idBits)), key };
}

export async function seal(key: CryptoKey, value: unknown): Promise<Sealed> {
  const packed = await gzip(new TextEncoder().encode(JSON.stringify(value)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed as BufferSource);
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Throws if the key is wrong or the data was tampered with. */
export async function open<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(sealed.iv) as BufferSource },
    key,
    fromB64(sealed.ct) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(plain))));
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
const gzip = (d: Uint8Array) => pipe(d, new CompressionStream('gzip'));
const gunzip = (d: Uint8Array) => pipe(d, new DecompressionStream('gzip'));

export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
