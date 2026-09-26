// PV-04: one contract, every email adapter.
//
//   memory   what tests use
//   console  development: it must still show who, what and the body
//   smtp     nodemailer with its JSON transport: the real message builder,
//            no network. What an SMTP server would receive is what we assert.

import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import {
  ConsoleEmailSender,
  MemoryEmailSender,
  SmtpEmailSender,
  type EmailMessage,
  type EmailSender,
} from '../providers/email/index.js';

type Delivered = { to: string; subject: string; text: string; html?: string; from?: string };

interface Harness {
  sender: EmailSender;
  delivered(): Delivered[];
  /** A sender whose provider refuses; absent where an adapter cannot fail. */
  failing?: EmailSender;
}

const FROM = 'Flyleaf <no-reply@flyleaf.app>';

const ADAPTERS: { name: string; make: () => Harness }[] = [
  {
    name: 'memory',
    make: () => {
      const sender = new MemoryEmailSender();
      return { sender, delivered: () => sender.sentMessages };
    },
  },
  {
    name: 'console',
    make: () => {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
      return {
        sender: new ConsoleEmailSender(),
        // What a developer reads in the terminal, parsed back.
        delivered: () =>
          lines
            .map((l, i) => ({ head: /^\[mail\] To: (.*) \| Subject: (.*)$/.exec(l), body: lines[i + 1] }))
            .filter((x) => x.head)
            .map((x) => ({
              to: x.head![1]!,
              subject: x.head![2]!,
              text: x.body!.replace(/^\[mail\] Content:\n/, '').replace(/\n$/, ''),
            })),
      };
    },
  },
  {
    name: 'smtp (nodemailer)',
    make: () => {
      const sent: Delivered[] = [];
      const transport = nodemailer.createTransport({ jsonTransport: true });
      const real = transport.sendMail.bind(transport);
      transport.sendMail = (async (opts: object) => {
        const info = await real(opts);
        const m = JSON.parse(String(info.message));
        sent.push({
          from: m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address,
          to: m.to.map((t: { address: string }) => t.address).join(','),
          subject: m.subject,
          text: m.text,
          ...(m.html ? { html: m.html } : {}),
        });
        return info;
      }) as typeof transport.sendMail;

      const broken = nodemailer.createTransport({ jsonTransport: true });
      broken.sendMail = (async () => {
        throw new Error('554 relay refused');
      }) as typeof broken.sendMail;

      return {
        sender: new SmtpEmailSender(FROM, transport),
        delivered: () => sent,
        failing: new SmtpEmailSender(FROM, broken),
      };
    },
  },
];

afterEach(() => vi.restoreAllMocks());

const MESSAGE: EmailMessage = {
  to: 'reader@example.com',
  subject: 'Verify your Flyleaf email',
  text: 'Tap the link to verify: https://flyleaf.app/verify?token=abc',
};

for (const adapter of ADAPTERS) {
  describe(`EmailSender contract: ${adapter.name}`, () => {
    it('delivers recipient, subject and text unchanged', async () => {
      const h = adapter.make();
      await h.sender.send(MESSAGE);
      expect(h.delivered()).toHaveLength(1);
      expect(h.delivered()[0]).toMatchObject({ to: MESSAGE.to, subject: MESSAGE.subject, text: MESSAGE.text });
    });

    it('delivers each message separately, in order', async () => {
      const h = adapter.make();
      await h.sender.send(MESSAGE);
      await h.sender.send({ ...MESSAGE, to: 'second@example.com', subject: 'Second' });
      expect(h.delivered().map((m) => m.to)).toEqual([MESSAGE.to, 'second@example.com']);
    });

    it('a provider refusal rejects the send, so the caller can see it', async () => {
      const h = adapter.make();
      if (!h.failing) return; // memory and console cannot be refused
      await expect(h.failing.send(MESSAGE)).rejects.toThrow('554 relay refused');
    });
  });
}

describe('smtp specifics', () => {
  it('sends from EMAIL_FROM and includes html only when given', async () => {
    const h = ADAPTERS[2]!.make();
    await h.sender.send(MESSAGE);
    await h.sender.send({ ...MESSAGE, html: '<p>Verify</p>' });
    const [plain, rich] = h.delivered();
    expect(plain!.from).toBe(FROM);
    expect(plain!.html).toBeUndefined();
    expect(rich!.html).toBe('<p>Verify</p>');
  });

  it('a CR/LF in the subject cannot add a header to the message on the wire', async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const raws: string[] = [];
    const real = transport.sendMail.bind(transport);
    transport.sendMail = (async (opts: object) => {
      const info = await real(opts);
      raws.push(String((info as { message: Buffer }).message));
      return info;
    }) as typeof transport.sendMail;

    await new SmtpEmailSender(FROM, transport).send({ ...MESSAGE, subject: 'Hi\r\nBcc: attacker@example.com' });

    const headers = raws[0]!.split('\r\n\r\n')[0]!;
    expect(headers).toMatch(/^Subject: /m);
    expect(headers).not.toMatch(/^Bcc:/im);
  });
});
