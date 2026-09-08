/**
 * Hash a plaintext API key the same way the service stores it.
 *
 *   npm run keys:hash -- "your-secret-key"
 *
 * Prints the SHA-256 (domain-separated) hash for manual ApiKey inserts.
 * Prefer letting the API/worker seed keys from API_KEY / ADMIN_API_KEY.
 */
import { hashApiKey } from '../src/utils/hashing.js';

const plaintext = process.argv[2];
if (!plaintext) {
  console.error('Usage: npm run keys:hash -- "your-secret-key"');
  process.exit(1);
}
console.log(hashApiKey(plaintext));
