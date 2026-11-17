import { strict as assert } from 'assert';
import type { QuotaState } from '../src/types-plugin.js';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

test('QuotaState type exists', () => {
  const state: QuotaState = { count: 2, expiresAt: Date.now() + 3600000 };
  assert(state.count === 2);
});

console.log('All type definition tests passed');
