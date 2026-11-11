import { PassThrough } from 'node:stream';
import { createTtyIo } from '../tty-io';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  return { input, output, written: () => written };
}

describe('createTtyIo (node:readline prompts)', () => {
  it('ask echoes what is typed; askHidden does not echo the password', async () => {
    const s = streams();
    const io = createTtyIo(s.input, s.output);
    const phone = io.ask('Phone: ');
    s.input.write('+998000000001\n');
    await expect(phone).resolves.toBe('+998000000001');
    const password = io.askHidden('Password: ');
    s.input.write('test-2fa-secret\n');
    await expect(password).resolves.toBe('test-2fa-secret');
    io.say('done');
    io.close();
    expect(s.written()).toContain('Phone: ');
    expect(s.written()).toContain('Password: ');
    expect(s.written()).toContain('done\n');
    expect(s.written()).not.toContain('test-2fa-secret');
  });
});
