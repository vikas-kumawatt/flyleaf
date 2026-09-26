// `smtp` email (PV-04): any SMTP relay -- Postmark, SES, Resend, Mailgun and
// SendGrid all offer one -- so choosing a vendor is a URL, not a code change.
// A vendor HTTP API adapter would be one more file beside this one.

import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from './local.js';

export class SmtpEmailSender implements EmailSender {
  /** `transport` is injectable so the contract suite runs without a server. */
  constructor(
    private readonly from: string,
    private readonly transport: Transporter,
  ) {}

  /** smtps://user:pass@smtp.example.com:465 or smtp://…:587 (STARTTLS). */
  static fromUrl(url: string, from: string): SmtpEmailSender {
    return new SmtpEmailSender(from, nodemailer.createTransport(url));
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  }
}
