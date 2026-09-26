// Email port (FN-65, PV-04). The templates (verification, reset, export
// ready) stay in the code that sends them; an adapter only delivers.
//
// `console` and `memory` never leave the process: development and tests.
// providers/index.ts refuses both when NODE_ENV=production.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  /** Resolves once the provider accepted the message; rejects if it did not. */
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
