import { describe, expect, it } from 'vitest';
import { deriveKeys, generateCode, isValidCode, open, randomSalt, seal } from '../src/crypto';
import { makeBackup, readBackup } from '../src/storage';
import { emptyProfile } from '../src/model';

describe('encryption', () => {
  it('generates readable 16-character codes', () => {
    const c = generateCode();
    expect(c).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect(isValidCode(c.toLowerCase().replace(/-/g, ' '))).toBe(true);
  });

  it('round-trips, and stored bytes do not contain the plain text', async () => {
    const salt = randomSalt();
    const code = generateCode();
    const k = await deriveKeys(code, salt);
    const sealed = await seal(k.key, { name: 'MAPLE, Q.', room: '214' });
    expect(atob(sealed.ct)).not.toContain('MAPLE');
    expect(await open(k.key, sealed)).toEqual({ name: 'MAPLE, Q.', room: '214' });
    // Same code + salt gives the same id; a different code does not open it.
    expect((await deriveKeys(code.toLowerCase(), salt)).id).toBe(k.id);
    const wrong = await deriveKeys(generateCode(), salt);
    expect(wrong.id).not.toBe(k.id);
    await expect(open(wrong.key, sealed)).rejects.toThrow();
  }, 30000);

  it('backup files need the right code', async () => {
    const code = generateCode();
    const p = emptyProfile();
    p.settings.section = '7';
    const file = await makeBackup(code, p);
    expect(JSON.stringify(file)).not.toContain('"section"');
    expect((await readBackup(file, code))?.settings.section).toBe('7');
    expect(await readBackup(file, generateCode())).toBeNull();
  }, 30000);
});
