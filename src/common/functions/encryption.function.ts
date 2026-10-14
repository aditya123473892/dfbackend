import { createCipheriv, randomBytes, createDecipheriv } from 'crypto';
const algorithm = 'aes-256-cbc';

export async function encrypt(data: string, key: string): Promise<string> {
  const iv = randomBytes(16);
  const cipher = createCipheriv(algorithm, Buffer.from(key, 'hex'), iv);
  let encrypted = cipher.update(data, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

export async function decrypt(data: string, key: string): Promise<string> {
  const [ivHex, encryptedData] = data.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv(algorithm, Buffer.from(key, 'hex'), iv);
  let decrypted = decipher.update(encryptedData, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}
