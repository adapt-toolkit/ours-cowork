// Existing SdkRoomPacket seam with a real V1 public client and daemon.
// No terminal release is used to manufacture a recoverable NOT_BOUND.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { attachOursClient } from '@ours.network/sdk';
import { SdkRoomPacket } from '../../src/packets.ts';

const [name, cid] = process.argv.slice(2);
const client = await attachOursClient({
  endpoint: process.env.OURS_DAEMON_URL,
  expectedInstanceId: process.env.OURS_DAEMON_ID,
  credentialPath: process.env.OURS_DAEMON_CREDENTIAL_PATH,
  sessionMode: 'external', leaseToken: randomUUID(), env: {},
});
const events = [];
const packet = new SdkRoomPacket(name, cid, client, {log: entry => events.push(JSON.parse(entry))});
try {
  await assert.rejects(() => client.listContacts(), error => error.code === 'NOT_BOUND');
  await packet.refresh();
  assert.equal((await client.currentIdentity()).cid, cid);
  assert.equal(events.filter(e => e.event === 'identity_rebind_succeeded').length, 1);
  await packet.close();
  await assert.rejects(() => packet.refresh(), error => error.code === 'BINDING_REASSIGNED');
  assert.equal(events.filter(e => e.event === 'identity_rebind_succeeded').length, 1);
  console.log('PASS actual public NOT_BOUND triggers exact packet rebind; terminally retired owner cannot rebind');
} finally {
  await client.releaseLease();
  await client.close();
}
