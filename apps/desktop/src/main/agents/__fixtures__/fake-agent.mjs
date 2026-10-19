// Minimal ACP agent used by manager.test.ts. Behaviour is selected by keywords in the user's prompt:
//   (default) message chunk, tool_call(locations), permission request, fs write, tool_call_update(diff)
//   "hang"    waits for session/cancel and answers stopReason=cancelled
//   "outside" tries fs/write_text_file outside the session cwd
//   "read"    reads lines 2-3 of lines.txt through fs/read_text_file
//   "crash"   exits with code 3
//   "noisy"   floods stderr
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';

if (process.env.FAKE_AGENT_PIDFILE) writeFileSync(process.env.FAKE_AGENT_PIDFILE, String(process.pid));
process.stderr.write('fake-agent booted\n');

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
let seq = 0;

new AgentSideConnection((conn) => {
  const sessions = new Map();
  const say = (sessionId, text) =>
    conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });

  return {
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        agentInfo: { name: 'fake-agent', version: '0.0.0' },
      };
    },
    async authenticate() {
      return {};
    },
    async newSession(params) {
      const sessionId = `fake-${process.pid}-${++seq}`;
      sessions.set(sessionId, { cwd: params.cwd, cancelled: null });
      if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ newSession: params }) + '\n');
      return {
        sessionId,
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan', description: 'Read only' },
          ],
        },
      };
    },
    async setSessionMode(params) {
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
      });
      return {};
    },
    async cancel(params) {
      sessions.get(params.sessionId)?.cancelled?.();
    },
    async prompt(params) {
      const { sessionId } = params;
      const session = sessions.get(sessionId);
      const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      await say(sessionId, `received:${JSON.stringify(params.prompt)}`);

      if (text.includes('crash')) process.exit(3);
      if (text.includes('noisy')) {
        for (let i = 0; i < 100; i++) process.stderr.write(`noise ${i}\n`);
        return { stopReason: 'end_turn' };
      }
      if (text.includes('hang')) {
        await new Promise((resolve) => (session.cancelled = resolve));
        return { stopReason: 'cancelled' };
      }
      if (text.includes('outside')) {
        try {
          await conn.writeTextFile({ sessionId, path: path.join(session.cwd, '..', 'escape.txt'), content: 'x' });
          await say(sessionId, 'outside:accepted');
        } catch (e) {
          await say(sessionId, `outside:rejected:${e.message}`);
        }
        return { stopReason: 'end_turn' };
      }
      if (text.includes('read')) {
        const res = await conn.readTextFile({ sessionId, path: path.join(session.cwd, 'lines.txt'), line: 2, limit: 2 });
        await say(sessionId, `read:${JSON.stringify(res.content)}`);
        return { stopReason: 'end_turn' };
      }

      const target = path.join(session.cwd, 'out', 'hello.txt');
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Write hello.txt',
          kind: 'edit',
          status: 'pending',
          locations: [{ path: target }],
        },
      });
      const perm = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'Write hello.txt' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      if (perm.outcome.outcome === 'selected' && perm.outcome.optionId === 'allow') {
        await conn.writeTextFile({ sessionId, path: target, content: 'hello from fake agent\n' });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'completed',
            content: [{ type: 'diff', path: target, oldText: null, newText: 'hello from fake agent\n' }],
          },
        });
        await say(sessionId, 'done');
      } else {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'failed' },
        });
        await say(sessionId, `permission:${perm.outcome.outcome}`);
      }
      return { stopReason: 'end_turn' };
    },
  };
}, stream);
