// Swap-ready email sender interface (FN-65, Architecture §2 & §7).
//
// Like RateLimiter and Cache, EmailSender is an interface from day one so that
// switching from console/dev to Resend/SES/Postmark in production is one
// implementation plus a config line, rather than scattered edits across auth handlers.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Dev/default sender: logs delivery to console without hitting any external API. */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log(`[mail] To: ${message.to} | Subject: ${message.subject}`);
    console.log(`[mail] Content:\n${message.text}\n`);
  }
}

/** Test sender: retains sent messages in memory for test assertions. */
export class MemoryEmailSender implements EmailSender {
  sentMessages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  clear(): void {
    this.sentMessages = [];
  }

  lastMessage(): EmailMessage | undefined {
    return this.sentMessages[this.sentMessages.length - 1];
  }
}
