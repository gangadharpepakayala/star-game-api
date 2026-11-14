/**
 * Utility functions for hashing and secure ID generation using Web Crypto API.
 */
export async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateId(prefix: string = ''): string {
  const randomPart = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return prefix ? `${prefix}_${randomPart}` : randomPart;
}

export function generateRoomCode(): string {
  // Generate uppercase room code like STAR8271
  const num = Math.floor(1000 + Math.random() * 9000);
  return `STAR${num}`;
}

export function generateSessionToken(playerId: string): string {
  const rand = crypto.randomUUID().replace(/-/g, '');
  const data = `${playerId}:${rand}:${Date.now()}`;
  return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function parseSessionToken(token: string): { playerId: string } | null {
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const parts = raw.split(':');
    if (parts.length >= 1 && parts[0]) {
      return { playerId: parts[0] };
    }
    return null;
  } catch {
    return null;
  }
}
