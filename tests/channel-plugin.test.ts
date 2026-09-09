/**
 * Integration test for qqbotPlugin
 * 
 * Verifies that the plugin has all required adapters
 * Note: createChatChannelPlugin spreads 'base' properties to top level
 */

import assert from 'node:assert';
import { qqbotPlugin } from '../src/channel.js';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

console.log('\n=== Channel Plugin Integration Tests ===\n');

test('qqbotPlugin is defined', () => {
  assert.ok(qqbotPlugin, 'qqbotPlugin should be defined');
});

test('qqbotPlugin has id', () => {
  assert.strictEqual(qqbotPlugin.id, 'qqbot', 'qqbotPlugin.id should be qqbot');
});

test('qqbotPlugin has meta', () => {
  assert.ok(qqbotPlugin.meta, 'qqbotPlugin should have meta');
  assert.strictEqual(qqbotPlugin.meta.label, 'QQ Bot', 'meta.label should be QQ Bot');
});

test('qqbotPlugin has capabilities', () => {
  assert.ok(qqbotPlugin.capabilities, 'qqbotPlugin should have capabilities');
  assert.ok(qqbotPlugin.capabilities.chatTypes, 'capabilities should have chatTypes');
});

test('qqbotPlugin has config adapter', () => {
  assert.ok(qqbotPlugin.config, 'qqbotPlugin should have config adapter');
  assert.ok(typeof qqbotPlugin.config.listAccountIds === 'function', 'config should have listAccountIds');
  assert.ok(typeof qqbotPlugin.config.resolveAccount === 'function', 'config should have resolveAccount');
  assert.ok(typeof qqbotPlugin.config.defaultAccountId === 'function', 'config should have defaultAccountId');
  assert.ok(typeof qqbotPlugin.config.isConfigured === 'function', 'config should have isConfigured');
  assert.ok(typeof qqbotPlugin.config.describeAccount === 'function', 'config should have describeAccount');
  assert.ok(typeof qqbotPlugin.config.setAccountEnabled === 'function', 'config should have setAccountEnabled');
  assert.ok(typeof qqbotPlugin.config.deleteAccount === 'function', 'config should have deleteAccount');
});

test('qqbotPlugin has message adapter', () => {
  assert.ok(qqbotPlugin.message, 'qqbotPlugin should have message adapter');
});

test('qqbotPlugin has messaging adapter', () => {
  assert.ok(qqbotPlugin.messaging, 'qqbotPlugin should have messaging adapter');
});

test('qqbotPlugin has status adapter', () => {
  assert.ok(qqbotPlugin.status, 'qqbotPlugin should have status adapter');
});

test('qqbotPlugin has gateway adapter', () => {
  assert.ok(qqbotPlugin.gateway, 'qqbotPlugin should have gateway adapter');
});

test('qqbotPlugin has outbound adapter', () => {
  assert.ok(qqbotPlugin.outbound, 'qqbotPlugin should have outbound adapter');
  assert.ok(typeof qqbotPlugin.outbound.sendTextWithQuota === 'function', 'outbound should have sendTextWithQuota');
  assert.ok(typeof qqbotPlugin.outbound.sendMediaWithQuota === 'function', 'outbound should have sendMediaWithQuota');
  assert.ok(typeof qqbotPlugin.outbound.canSendTyping === 'function', 'outbound should have canSendTyping');
});

test('qqbotPlugin has agentPrompt adapter', () => {
  assert.ok(qqbotPlugin.agentPrompt, 'qqbotPlugin should have agentPrompt adapter');
});

test('qqbotPlugin has heartbeat adapter', () => {
  assert.ok(qqbotPlugin.heartbeat, 'qqbotPlugin should have heartbeat adapter');
});

test('qqbotPlugin has threading adapter', () => {
  assert.ok(qqbotPlugin.threading, 'qqbotPlugin should have threading adapter');
});

test('qqbotPlugin has groups adapter', () => {
  assert.ok(qqbotPlugin.groups, 'qqbotPlugin should have groups adapter');
  assert.ok(typeof qqbotPlugin.groups.resolveRequireMention === 'function', 'groups should have resolveRequireMention');
  assert.ok(typeof qqbotPlugin.groups.resolveToolPolicy === 'function', 'groups should have resolveToolPolicy');
});

test('qqbotPlugin has mentions adapter', () => {
  assert.ok(qqbotPlugin.mentions, 'qqbotPlugin should have mentions adapter');
  assert.ok(typeof qqbotPlugin.mentions.stripMentions === 'function', 'mentions should have stripMentions');
});

test('qqbotPlugin has setup adapter', () => {
  assert.ok(qqbotPlugin.setup, 'qqbotPlugin should have setup adapter');
  assert.ok(typeof qqbotPlugin.setup.resolveAccountId === 'function', 'setup should have resolveAccountId');
  assert.ok(typeof qqbotPlugin.setup.applyAccountName === 'function', 'setup should have applyAccountName');
  assert.ok(typeof qqbotPlugin.setup.validateInput === 'function', 'setup should have validateInput');
  assert.ok(typeof qqbotPlugin.setup.applyAccountConfig === 'function', 'setup should have applyAccountConfig');
});

test('qqbotPlugin has setupWizard', () => {
  assert.ok(qqbotPlugin.setupWizard, 'qqbotPlugin should have setupWizard');
});

test('qqbotPlugin has auth adapter', () => {
  assert.ok(qqbotPlugin.auth, 'qqbotPlugin should have auth adapter');
  assert.ok(qqbotPlugin.auth.login, 'auth should have login');
});

test('qqbotPlugin has setup wizard', () => {
  assert.ok(qqbotPlugin.setupWizard, 'qqbotPlugin should have setupWizard (guided setup)');
});

test('outbound adapter has deliveryMode', () => {
  assert.ok(qqbotPlugin.outbound.deliveryMode, 'outbound should have deliveryMode');
  assert.strictEqual(qqbotPlugin.outbound.deliveryMode, 'direct', 'deliveryMode should be direct');
});

test('outbound adapter has shouldSuppressLocalPayloadPrompt', () => {
  assert.ok(typeof qqbotPlugin.outbound.shouldSuppressLocalPayloadPrompt === 'function', 
    'outbound should have shouldSuppressLocalPayloadPrompt');
});

test('outbound adapter has shouldTreatDeliveredTextAsVisible', () => {
  assert.ok(typeof qqbotPlugin.outbound.shouldTreatDeliveredTextAsVisible === 'function', 
    'outbound should have shouldTreatDeliveredTextAsVisible');
});

test('outbound adapter has preferFinalAssistantVisibleText', () => {
  assert.ok(typeof qqbotPlugin.outbound.preferFinalAssistantVisibleText === 'boolean', 
    'outbound should have preferFinalAssistantVisibleText');
});

console.log('\n✓ All tests passed!\n');
